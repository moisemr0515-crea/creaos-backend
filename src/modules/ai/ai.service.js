const OpenAI = require('openai');
const { OPENAI_API_KEY, OPENAI_MODEL, AI_MAX_TOKENS, AI_TEMPERATURE } = require('../../config/env');
const Conversation = require('./conversation.model');
const Lead = require('../leads/lead.model');
const { AppError } = require('../../middleware/error.middleware');
const channelService = require('../channels/channel.service');
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

const chat = async (conversationId, userMessage, business, lead) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  conversation.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date(),
  });

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

  const mensaje = {
    role: 'assistant',
    content: text,
    timestamp: new Date(),
    sentBy: 'agent',
    whatsappStatus: 'not_applicable',
    whatsappError: null,
    metadata: actor ? { agentId: actor._id, agentName: actor.name } : undefined,
  };

  const esCanalWhatsApp = conversation.channel === 'whatsapp';
  const tieneTelefono = Boolean(lead?.phone);

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

module.exports = { buildSystemPrompt, chat, qualifyLead, generateSummary, suggestResponse, sendAgentMessage };
