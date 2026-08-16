const OpenAI = require('openai');
const { OPENAI_API_KEY, OPENAI_MODEL, AI_MAX_TOKENS, AI_TEMPERATURE } = require('../../config/env');
const Conversation = require('./conversation.model');
const Lead = require('../leads/lead.model');
const { AppError } = require('../../middleware/error.middleware');
const channelService = require('../channels/channel.service');
// Se requiere el módulo completo (no se destructura subirBuffer acá) para
// que la llamada use siempre la referencia viva del export — mismo motivo
// que gupshupProvider.js con gupshup.client.js: permite mockearlo en tests
// sin tocar el módulo real.
const cloudinaryUtil = require('../../utils/cloudinary');
const logger = require('../../utils/logger');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const buildSystemPrompt = (business, lead) => {
  const infoNegocio = [
    business.productDescription && `- Qué vende: ${business.productDescription}`,
    business.targetCustomer && `- Cliente ideal: ${business.targetCustomer}`,
    // Se usa el resumen (barato en tokens) en vez del texto completo del PDF;
    // pdfExtractedText queda como fallback para PDFs subidos antes de tener resumen
    (business.pdfSummary || business.pdfExtractedText) &&
      `- Información adicional del negocio (de su documento):\n${business.pdfSummary || business.pdfExtractedText}`,
  ].filter(Boolean).join('\n');

  const bloqueInstruccionesDueno = business.aiInstructions
    ? `\nINSTRUCCIONES ESPECÍFICAS DEL DUEÑO DEL NEGOCIO (síguelas estrictamente, tienen prioridad sobre las instrucciones generales de abajo):\n${business.aiInstructions}\n`
    : '';

  return `Eres Alex, un agente de ventas profesional y empático de ${business.name}.
${infoNegocio ? `\nINFORMACIÓN DEL NEGOCIO:\n${infoNegocio}\n` : ''}
Tu objetivo es calificar al lead y guiarlo hacia una venta de manera natural y conversacional.
${bloqueInstruccionesDueno}
INFORMACIÓN DEL LEAD:
- Nombre: ${lead.name}
- Empresa: ${lead.company || 'No especificada'}
- Temperatura actual: ${lead.temperature || 'cold'}
- Etapa del pipeline: ${lead.pipelineStage || 'new'}
- Valor potencial: ${lead.potentialValue ? `$${lead.potentialValue} ${lead.currency || 'USD'}` : 'No definido'}

INSTRUCCIONES:
1. Responde siempre en el mismo idioma que el usuario
2. Mantén un tono profesional pero cercano y empático
3. Haz preguntas abiertas para entender las necesidades del lead
4. Evalúa internamente: temperatura del lead (cold/warm/hot), intención (buying/researching/not_interested/unknown) y score de calificación (0-100)
5. Si el lead muestra señales de compra, sugiere agendar una llamada o enviar una propuesta
6. Mantén respuestas concisas (máximo 3 párrafos)
7. Nunca menciones que eres una IA a menos que te lo pregunten directamente`;
};

/**
 * Guarda un mensaje ENTRANTE real del lead en conversation.messages — paso
 * independiente de si la IA le va a responder o no.
 *
 * Hallazgo real (no hipotético): antes, esto solo pasaba como efecto
 * colateral de chat() (que guardaba el entrante Y generaba la respuesta de
 * la IA en el mismo paso, atómicamente). processGupshupMessage()/
 * processInboundJob() (inbound.worker.js) solo llamaban a chat() cuando
 * conversation.aiEnabled era true — si un agente ya había intervenido en la
 * conversación (aiEnabled queda en false después de CUALQUIER
 * sendAgentMessage/sendTemplateMessage/sendMediaMessage, el estado casi
 * permanente de una conversación real), el mensaje real que mandó el lead
 * por WhatsApp NUNCA quedaba guardado en ningún lado — ni en
 * conversation.messages ni en ningún otro registro (confirmado en
 * producción: 3 mensajes reales de "Crea Emprendedores" en una sola
 * mañana, resueltos correctamente al lead/conversación, con
 * lastInboundMessageAt actualizado, pero ausentes de conversation.messages
 * porque aiEnabled era false en los 3 casos).
 *
 * @param {string} conversationId
 * @param {string} text
 * @returns {Promise<import('./conversation.model')>} la conversación actualizada
 */
const saveInboundMessage = async (conversationId, text) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  conversation.messages.push({
    role: 'user',
    content: text,
    timestamp: new Date(),
  });
  await conversation.save();

  return conversation;
};

/**
 * Genera y guarda la respuesta de la IA para una conversación — asume que
 * el mensaje del lead que se está respondiendo YA está guardado en
 * conversation.messages (ver saveInboundMessage(), que debe llamarse
 * antes). Vuelve a leer la conversación de la base (no reusa un objeto en
 * memoria) para tomar siempre el estado más reciente de `messages` como
 * contexto del prompt.
 */
const generateReply = async (conversationId, business, lead) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const systemPrompt = buildSystemPrompt(business, lead);
  const recentMessages = conversation.messages.slice(-10).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
    max_tokens: AI_MAX_TOKENS,
    temperature: AI_TEMPERATURE,
  });

  const reply = completion.choices[0].message.content;
  const promptTokens = completion.usage?.prompt_tokens || 0;
  const completionTokens = completion.usage?.completion_tokens || 0;
  const tokensUsed = completion.usage?.total_tokens || (promptTokens + completionTokens);

  conversation.messages.push({
    role: 'assistant',
    content: reply,
    timestamp: new Date(),
    tokens: tokensUsed,
    // Desglose prompt/completion para costo exacto (ver config/aiPricing.js).
    // Mensajes anteriores a este cambio no lo tienen — el cálculo de costo cae
    // a una tarifa combinada estimada para esos casos.
    metadata: { promptTokens, completionTokens, model: OPENAI_MODEL },
  });
  conversation.totalTokensUsed += tokensUsed;
  await conversation.save();

  return { reply, tokensUsed, conversationId: conversation._id };
};

/**
 * sendMessage() (ai.controller.js, simula lo que dijo el lead para probar
 * la respuesta de la IA) sigue usando esta función tal cual — mismo
 * contrato y mismo comportamiento externo que antes (guarda el mensaje del
 * "lead" + genera y guarda la respuesta, en un solo paso). Por dentro ahora
 * es la composición de saveInboundMessage() + generateReply(), para que
 * processGupshupMessage()/processInboundJob() puedan usar esos 2 pasos por
 * separado (guardar SIEMPRE, responder solo si aiEnabled).
 */
const chat = async (conversationId, userMessage, business, lead) => {
  // module.exports.X(...) en vez de llamar a X(...) directo (la referencia
  // local del mismo archivo) — a propósito: mismo principio de "referencia
  // viva" que gupshupProvider.js aplica a gupshup.client.js, pero acá hace
  // falta explícito porque saveInboundMessage/generateReply están en ESTE
  // mismo módulo (una llamada directa a la const local ignora cualquier
  // mock hecho sobre aiService.saveInboundMessage/aiService.generateReply
  // desde afuera — hallazgo real: sin esto, un test que mockea
  // aiService.generateReply para no llamar a OpenAI de verdad NO lo
  // interceptaba al pasar por chat(), y terminaba pegándole a la API real).
  await module.exports.saveInboundMessage(conversationId, userMessage);
  return module.exports.generateReply(conversationId, business, lead);
};

const qualifyLead = async (conversationId, lead) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const messagesText = conversation.messages
    .filter((m) => m.role !== 'system')
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'Lead' : 'Agente'}: ${m.content}`)
    .join('\n');

  const prompt = `Analiza esta conversación de ventas y califica al lead.

CONVERSACIÓN:
${messagesText}

Responde ÚNICAMENTE con JSON válido siguiendo este formato exacto:
{
  "score": <número 0-100>,
  "temperature": <"cold" | "warm" | "hot">,
  "intent": <"buying" | "researching" | "not_interested" | "unknown">,
  "budget": <presupuesto mencionado como string, o null>,
  "timeline": <plazo de compra como string, o null>,
  "notes": <observaciones clave en 1-2 oraciones>
}`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'Eres un experto en calificación de leads. Respondes únicamente con JSON válido.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 500,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  let qualification;
  try {
    qualification = JSON.parse(completion.choices[0].message.content);
  } catch {
    throw new AppError('Error al parsear calificación de IA', 500);
  }

  conversation.leadQualification = { ...qualification, qualifiedAt: new Date() };
  conversation.totalTokensUsed += completion.usage?.total_tokens || 0;
  await conversation.save();

  if (qualification.temperature && qualification.temperature !== lead.temperature) {
    await Lead.findByIdAndUpdate(lead._id, { temperature: qualification.temperature });
  }

  return qualification;
};

const generateSummary = async (conversationId) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const messagesText = conversation.messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'Lead' : 'Agente'}: ${m.content}`)
    .join('\n');

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'Eres un experto en ventas que genera resúmenes ejecutivos concisos y accionables.' },
      {
        role: 'user',
        content: `Genera un resumen ejecutivo de esta conversación en 3-5 puntos numerados. Incluye: qué quiere el lead, objeciones mencionadas, nivel de interés, info relevante (presupuesto/plazo) y siguiente paso recomendado.\n\nCONVERSACIÓN:\n${messagesText}`,
      },
    ],
    max_tokens: 600,
    temperature: 0.4,
  });

  const summary = completion.choices[0].message.content;
  conversation.summary = summary;
  conversation.totalTokensUsed += completion.usage?.total_tokens || 0;
  await conversation.save();

  return summary;
};

const suggestResponse = async (leadId, context) => {
  const lead = await Lead.findById(leadId);
  if (!lead) throw new AppError('Lead no encontrado', 404);

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'Eres un coach de ventas experto. Respondes únicamente con JSON válido.' },
      {
        role: 'user',
        content: `Sugiere 3 respuestas que un vendedor podría usar.

LEAD: ${lead.name} de ${lead.company || 'empresa desconocida'}
TEMPERATURA: ${lead.temperature} | ETAPA: ${lead.pipelineStage}
CONTEXTO: ${context}

Genera 3 respuestas cortas (máx 2 oraciones), variando el tono:
1. Directa y orientada a acción
2. Empática y consultiva
3. Con pregunta abierta

Responde: { "suggestions": ["respuesta1", "respuesta2", "respuesta3"] }`,
      },
    ],
    max_tokens: 400,
    temperature: 0.8,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content);
    return parsed.suggestions || [];
  } catch {
    throw new AppError('Error al generar sugerencias', 500);
  }
};

/**
 * Un agente humano escribe un mensaje en el chat del CRM para mandárselo al
 * lead — a diferencia de chat() (que recibe lo que dijo el LEAD y genera la
 * respuesta de la IA), acá el texto ya viene decidido por una persona: se
 * guarda tal cual y, si la conversación es por WhatsApp, se intenta despachar
 * de verdad vía Gupshup.
 *
 * Fail-soft a propósito: un fallo de Gupshup (caído, número inválido, etc.)
 * NUNCA debe perder el mensaje que el agente ya escribió — se guarda igual,
 * marcado whatsappStatus:'failed', para que el frontend pueda mostrar el
 * error real en vez de un falso "enviado".
 *
 * Al intervenir un humano, se apaga aiEnabled para esta conversación (mismo
 * criterio que escalate()) — evita que la IA responda por encima del agente
 * en el próximo mensaje entrante del lead.
 */
const sendAgentMessage = async (conversationId, text, actor) => {
  if (!text?.trim()) throw new AppError('El mensaje no puede estar vacío', 400);

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const lead = await Lead.findById(conversation.lead);
  // La Conversation de un lead soft-deleted NO se marca isDeleted a su vez
  // (son entidades independientes) — sigue 100% funcional salvo este
  // chequeo. Sin esto, un conversationId viejo (cacheado en el frontend,
  // un tab abierto, etc.) apuntando a un lead ya descartado como duplicado
  // permite seguir mandando mensajes reales por WhatsApp al número de ESE
  // lead — que puede no ser el que la persona cree estar viendo. Hallazgo
  // real, no hipotético: así se explicó un caso de "el mensaje llegó al
  // número equivocado" que en realidad era un conversationId de un lead
  // ya soft-deleted.
  if (!lead || lead.isDeleted) {
    throw new AppError('No se puede enviar el mensaje: el lead asociado a esta conversación ya no existe o fue eliminado', 404);
  }

  const esCanalWhatsApp = conversation.channel === 'whatsapp';
  const tieneTelefono = Boolean(lead?.phone);

  // Ventana de 24h de WhatsApp Business (Meta): fuera de las 24h desde el
  // último mensaje ENTRANTE real del lead, Meta rechaza texto libre — solo
  // admite reabrir con una plantilla aprobada (ver sendTemplateMessage()).
  // Antes de este chequeo, ese rechazo llegaba recién en el catch de abajo
  // (como cualquier otro fallo de Gupshup) y el mensaje quedaba guardado
  // igual marcado whatsappStatus:'failed' — silencioso y con un error crudo
  // de la API en vez de una explicación clara. Se rechaza acá, ANTES de
  // guardar nada, mismo criterio que el chequeo de lead soft-deleted de
  // arriba.
  if (esCanalWhatsApp && tieneTelefono && !conversation.getWindowState().windowOpen) {
    throw new AppError('La ventana de 24h de WhatsApp está cerrada — se requiere enviar una plantilla aprobada', 422);
  }

  const mensaje = {
    role: 'assistant',
    content: text,
    timestamp: new Date(),
    sentBy: 'agent',
    whatsappStatus: 'not_applicable',
    whatsappError: null,
    metadata: actor ? { agentId: actor._id, agentName: actor.name } : undefined,
  };

  if (esCanalWhatsApp && tieneTelefono) {
    try {
      // channelService.sendMessage() (sub-fase 1.b) es síncrono — se
      // resuelve el canal por `conversation.business` (no `tenantId`: ese
      // campo sigue siendo opcional en Conversation, sin backfill todavía;
      // `business` es requerido desde siempre y tiene el mismo valor,
      // Decisión 1). Este envío NO pasa por la cola de salida — esa cola
      // (sub-fase 1.d) es solo para las respuestas automáticas de la IA.
      const channel = await channelService.getChannelForTenant(conversation.business);
      if (!channel) {
        // Antes de esta sub-fase, el envío siempre se intentaba vía el
        // número compartido — este es un modo de fallo NUEVO para negocios
        // sin un WhatsAppChannel activo todavía (migración de Channel Core
        // incompleta para ese tenant). Se loguea aparte, a nivel warn, para
        // poder detectar qué tenants están en esta situación sin esperar a
        // que alguien reporte el mensaje "perdido" (hallazgo de code review).
        logger.warn(`sendAgentMessage: sin WhatsAppChannel activo para el tenant ${conversation.business} (conversación ${conversationId})`);
        throw new Error(`Ningún WhatsAppChannel activo para el tenant ${conversation.business}`);
      }
      await channelService.sendMessage(channel._id, lead.phone, text);
      mensaje.whatsappStatus = 'sent';
    } catch (error) {
      // No relanzar: el mensaje se guarda igual, solo queda marcado como fallido.
      logger.error(`No se pudo enviar mensaje de agente por WhatsApp (conversación ${conversationId}): ${error.message}`);
      mensaje.whatsappStatus = 'failed';
      mensaje.whatsappError = error.message;
    }
  } else if (esCanalWhatsApp && !tieneTelefono) {
    // Caso legítimo, no un bug: conversación marcada whatsapp pero el lead
    // no tiene teléfono registrado — no hay a dónde despachar.
    mensaje.whatsappError = 'El lead no tiene un número de teléfono registrado';
  }
  // Si el canal no es whatsapp (manual/web/email), whatsappStatus se queda
  // en 'not_applicable' sin más — es una conversación legítimamente sin
  // canal de WhatsApp, no un error.

  conversation.messages.push(mensaje);
  conversation.aiEnabled = false; // el agente toma el control manual de esta conversación
  await conversation.save();

  return conversation.messages[conversation.messages.length - 1];
};

/**
 * Envía una plantilla aprobada de WhatsApp Business a un lead — a diferencia
 * de sendAgentMessage() (texto libre), esto NO requiere que la ventana de
 * 24h esté abierta: es justamente el mecanismo para reabrirla. Por el mismo
 * motivo, tampoco actualiza conversation.lastInboundMessageAt — solo un
 * WhatsApp entrante real del lead abre/renueva la ventana (ver
 * conversation.model.js), nunca un mensaje saliente nuestro.
 *
 * Mismo criterio de guard (lead soft-deleted) y mismo fail-soft de Gupshup
 * (nunca se pierde el registro de que se intentó, aunque el envío falle)
 * que sendAgentMessage() — pero SIN el chequeo de ventana, obviamente.
 *
 * @param {string} conversationId
 * @param {{ id: string, params?: string[] }} template
 * @param {{_id, name}} [actor]
 */
const sendTemplateMessage = async (conversationId, template, actor) => {
  if (!template?.id) throw new AppError('templateId es requerido', 400);

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const lead = await Lead.findById(conversation.lead);
  if (!lead || lead.isDeleted) {
    throw new AppError('No se puede enviar la plantilla: el lead asociado a esta conversación ya no existe o fue eliminado', 404);
  }
  if (conversation.channel !== 'whatsapp') {
    throw new AppError('Las plantillas de WhatsApp solo aplican a conversaciones por ese canal', 400);
  }
  if (!lead.phone) {
    throw new AppError('El lead no tiene un número de teléfono registrado', 400);
  }

  const mensaje = {
    role: 'assistant',
    content: `[Plantilla: ${template.id}]`,
    timestamp: new Date(),
    sentBy: 'agent',
    whatsappStatus: 'not_applicable',
    whatsappError: null,
    metadata: {
      isTemplate: true,
      templateId: template.id,
      templateParams: template.params || [],
      ...(actor ? { agentId: actor._id, agentName: actor.name } : {}),
    },
  };

  try {
    const channel = await channelService.getChannelForTenant(conversation.business);
    if (!channel) {
      logger.warn(`sendTemplateMessage: sin WhatsAppChannel activo para el tenant ${conversation.business} (conversación ${conversationId})`);
      throw new Error(`Ningún WhatsAppChannel activo para el tenant ${conversation.business}`);
    }
    await channelService.sendTemplate(channel._id, lead.phone, template);
    mensaje.whatsappStatus = 'sent';
  } catch (error) {
    logger.error(`No se pudo enviar plantilla de WhatsApp (conversación ${conversationId}): ${error.message}`);
    mensaje.whatsappStatus = 'failed';
    mensaje.whatsappError = error.message;
  }

  conversation.messages.push(mensaje);
  // Mismo criterio que sendAgentMessage(): un agente inició este envío
  // (aunque sea una plantilla, no texto libre) — toma el control manual.
  conversation.aiEnabled = false;
  await conversation.save();

  return conversation.messages[conversation.messages.length - 1];
};

/**
 * Envía un mensaje con media (imagen/video) a un lead — como sendAgentMessage()
 * (texto libre), SÍ requiere que la ventana de 24h esté abierta: Meta trata
 * la media como mensaje de sesión, no de plantilla (a diferencia de
 * sendTemplateMessage()).
 *
 * Acepta dos modos (confirmado con el usuario — le da flexibilidad al
 * frontend sin costo extra real):
 *  - `file`: buffer ya validado por multer (mimetype/tamaño) — se sube a
 *    Cloudinary acá mismo; el mediaType se infiere del mimetype REAL del
 *    archivo (no se confía en lo que declare el cliente).
 *  - `mediaUrl` + `mediaType`: el archivo ya está alojado (ej. el frontend
 *    lo subió directo a Cloudinary del lado del cliente) — mediaType es
 *    obligatorio en este caso porque no hay mimetype real que inspeccionar
 *    sin una llamada HTTP extra.
 *
 * Los guards (lead activo, canal, teléfono, ventana) se chequean ANTES de
 * subir nada a Cloudinary — evita gastar un upload si el envío se va a
 * rechazar igual. Mismo fail-soft de Gupshup y mismo apagado de aiEnabled
 * que sendAgentMessage()/sendTemplateMessage().
 *
 * @param {string} conversationId
 * @param {{ file?: {buffer:Buffer, mimetype:string}, mediaUrl?: string, mediaType?: 'image'|'video', caption?: string }} media
 * @param {{_id, name}} [actor]
 */
const sendMediaMessage = async (conversationId, media, actor) => {
  if (!media?.file && !media?.mediaUrl) {
    throw new AppError('Se requiere un archivo (media) o una mediaUrl ya alojada', 400);
  }
  if (media.mediaUrl && !media.file && !media.mediaType) {
    throw new AppError('mediaType es requerido cuando se envía mediaUrl sin archivo', 400);
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const lead = await Lead.findById(conversation.lead);
  // Mismo chequeo que sendAgentMessage()/sendTemplateMessage() — ver el
  // comentario detallado en sendAgentMessage() sobre por qué es necesario.
  if (!lead || lead.isDeleted) {
    throw new AppError('No se puede enviar el mensaje: el lead asociado a esta conversación ya no existe o fue eliminado', 404);
  }
  if (conversation.channel !== 'whatsapp') {
    throw new AppError('El envío de imágenes/video solo aplica a conversaciones por WhatsApp', 400);
  }
  if (!lead.phone) {
    throw new AppError('El lead no tiene un número de teléfono registrado', 400);
  }

  // Ventana de 24h — mismo criterio que sendAgentMessage(): la media es
  // mensaje de sesión, no de plantilla, así que Meta exige la ventana
  // abierta igual que texto libre.
  if (!conversation.getWindowState().windowOpen) {
    throw new AppError('La ventana de 24h de WhatsApp está cerrada — se requiere enviar una plantilla aprobada', 422);
  }

  let url = media.mediaUrl;
  let mediaType = media.mediaType;

  if (media.file) {
    const resourceType = media.file.mimetype.startsWith('video/') ? 'video' : 'image';
    mediaType = resourceType;
    const resultado = await cloudinaryUtil.subirBuffer(media.file.buffer, {
      folder: `creaos/conversations/${conversationId}/media`,
      resource_type: resourceType,
    });
    url = resultado.secure_url;
  }

  const mensaje = {
    role: 'assistant',
    content: media.caption || (mediaType === 'video' ? '[Video]' : '[Imagen]'),
    timestamp: new Date(),
    sentBy: 'agent',
    whatsappStatus: 'not_applicable',
    whatsappError: null,
    mediaUrl: url,
    mediaType,
    metadata: actor ? { agentId: actor._id, agentName: actor.name } : undefined,
  };

  try {
    const channel = await channelService.getChannelForTenant(conversation.business);
    if (!channel) {
      logger.warn(`sendMediaMessage: sin WhatsAppChannel activo para el tenant ${conversation.business} (conversación ${conversationId})`);
      throw new Error(`Ningún WhatsAppChannel activo para el tenant ${conversation.business}`);
    }
    await channelService.sendMedia(channel._id, lead.phone, { url, type: mediaType, caption: media.caption });
    mensaje.whatsappStatus = 'sent';
  } catch (error) {
    // No relanzar: el mensaje (y el archivo, ya subido a Cloudinary) se
    // guardan igual, solo queda marcado como fallido.
    logger.error(`No se pudo enviar media por WhatsApp (conversación ${conversationId}): ${error.message}`);
    mensaje.whatsappStatus = 'failed';
    mensaje.whatsappError = error.message;
  }

  conversation.messages.push(mensaje);
  conversation.aiEnabled = false; // mismo criterio que sendAgentMessage()/sendTemplateMessage()
  await conversation.save();

  return conversation.messages[conversation.messages.length - 1];
};

module.exports = { buildSystemPrompt, chat, saveInboundMessage, generateReply, qualifyLead, generateSummary, suggestResponse, sendAgentMessage, sendTemplateMessage, sendMediaMessage };
