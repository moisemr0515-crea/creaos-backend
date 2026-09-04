const OpenAI = require('openai');
const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_MODEL_CHEAP, AI_MODEL_ROUTING_ENABLED, AI_MAX_TOKENS, AI_TEMPERATURE } = require('../../config/env');
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
const { TOOL_SCHEMAS, executeToolCall } = require('./tools');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Máximo de vueltas del loop tool-calling de generateReply() antes de
// cortar con error — corte de seguridad, no un caso esperado en uso real
// (un lead real no dispara 5 tool calls encadenadas en un solo turno).
const MAX_TOOL_ITERATIONS = 5;

/**
 * PR39 del blueprint de Fase 2 — model routing. Con AI_MODEL_ROUTING_ENABLED
 * en false (default, config/env.js), esTurnoSimple() ni se evalúa:
 * selectModel() devuelve OPENAI_MODEL siempre, generateReply() se comporta
 * byte a byte igual que antes de este PR.
 *
 * Con el flag activo, las 4 condiciones van con AND — cualquier dato
 * faltante o con forma inesperada hace que la condición correspondiente
 * sea false, nunca true por default (fail-soft: ante la duda, modelo
 * grande, nunca el barato por defecto):
 *
 * 1. La conversación tiene 2 mensajes o menos — el turno está dentro del
 *    primer intercambio real.
 * 2. El contenido combinado de recentMessages (la misma ventana de
 *    últimos 10 que ya arma generateReply()) no pasa de ~500 caracteres —
 *    cubre un primer mensaje inusualmente largo.
 * 3. Ningún mensaje de recentMessages tiene role:'tool' — sin actividad
 *    de tools todavía en esta conversación. Nota: recentMessages es un
 *    map() que solo conserva {role, content} (ver generateReply()), así
 *    que no tiene sentido chequear toolCalls acá — el mensaje role:'tool'
 *    (el resultado de la tool) es señal suficiente por sí sola, siempre
 *    aparece junto a cualquier tool call que haya ocurrido dentro de la
 *    ventana visible.
 * 4. Si leadQualification.psychologicalState existe, tiene que mapear al
 *    modo 'discovery' de PSYCHOLOGICAL_STATE_MODE (PR37, reutilizada tal
 *    cual, sin import nuevo — ya vive en este archivo). Sin
 *    psychologicalState todavía, esta condición no bloquea: ausencia de
 *    evidencia no es evidencia de complejidad.
 *
 * Por qué no hace falta escalar a mitad de turno si la heurística se
 * equivoca: OPENAI_MODEL_CHEAP (gpt-4o-mini por default) soporta function
 * calling igual que OPENAI_MODEL — se manda el mismo `tools: TOOL_SCHEMAS`
 * sin importar qué modelo eligió esta función, así que el loop de PR33
 * maneja un tool call exactamente igual con cualquiera de los dos. El
 * riesgo de una mala clasificación es una respuesta de texto menos
 * matizada para ESE turno puntual, no una falla funcional ni una tool
 * inaccesible.
 */
const esTurnoSimple = (conversation, leadQualification, recentMessages) => {
  const pocosMensajes = conversation.messages.length <= 2;

  const contextoCorto = recentMessages.reduce((total, m) => total + (m.content?.length || 0), 0) <= 500;

  const sinActividadDeTools = !recentMessages.some((m) => m.role === 'tool');

  const estadoEsDiscovery = !leadQualification?.psychologicalState
    || PSYCHOLOGICAL_STATE_MODE[leadQualification.psychologicalState] === 'discovery';

  return pocosMensajes && contextoCorto && sinActividadDeTools && estadoEsDiscovery;
};

const selectModel = (conversation, leadQualification, recentMessages) => {
  if (!AI_MODEL_ROUTING_ENABLED) return OPENAI_MODEL;
  return esTurnoSimple(conversation, leadQualification, recentMessages) ? OPENAI_MODEL_CHEAP : OPENAI_MODEL;
};

// Doctrina comercial fija (PR34 del blueprint de Fase 2) — condensada de
// docs/modules/Módulo 03 (CREA 10D™), 06 (Objection Engine™) y 07
// (Micro-Closing Engine™). Decisión explícita del blueprint: 10D se trata
// como doctrina de prompt, NO como una máquina de estados con schema
// propio — ninguno de los 3 módulos fuente recibió schema ni arquitectura
// técnica en docs/modules (a diferencia de Buyer Intelligence/Psychological
// State, que sí la tienen), así que formalizar un estado nuevo acá sería
// inventar estructura sin respaldo documental. Por eso este bloque es texto
// que orienta el tono/criterio del modelo, no un campo que se lea o escriba
// en ningún lado — cero cambio de schema, cero llamada nueva a OpenAI.
// SIEMPRE estático (nunca se condiciona) — a diferencia del bloque de
// Objection/Micro-Closing de abajo, que PR37 sí condiciona.
const METHODOLOGY_10D_GUIDANCE = `METODOLOGÍA COMERCIAL — CREA 10D™:
Tu conversación avanza por diez etapas: Detectar (¿quién es?) → Descubrir (¿qué necesita?) → Diagnosticar (¿cuál es el problema real detrás de lo que pide?) → Desear (¿qué resultado quiere lograr?) → Doler (¿qué le cuesta hoy no resolverlo?) → Demostrar (¿por qué esta solución tiene sentido para ÉL?) → Desarmar (eliminar objeciones) → Decidir (ayudarlo a decidir sin presionar) → Cerrar (convertir intención en acción concreta) → Desarrollar (acompañarlo después de la compra). No es un guion que debas recitar en orden: es un mapa. Identifica en qué etapa está la conversación AHORA y actúa según eso — si el lead ya está listo para comprar, no lo hagas retroceder a preguntas de descubrimiento; si presenta una objeción, pasa a desarmarla en vez de seguir demostrando.`;

// Fallback estático de Objection/Micro-Closing (texto literal de PR34,
// sin cambios) — usado por buildObjectionMicroClosingGuidance() cuando NO
// hay leadQualification.psychologicalState real todavía (lead nuevo,
// primera interacción, antes del primer qualifyLead() de PR35/36). Fail-soft
// a propósito: el prompt nunca debe fallar ni quedar sin este bloque solo
// porque el scoring todavía no corrió.
const STATIC_OBJECTION_MICROCLOSING_GUIDANCE = `MANEJO DE OBJECIONES:
Una objeción no es un rechazo — es una fricción entre lo que el lead quiere y lo que le impide avanzar. Nunca la respondas automáticamente (ej. "está caro" no significa automáticamente "ofrece descuento"). Diagnostica primero la causa real: puede ser comparación con otra opción, presupuesto, valor no percibido, falta de confianza, falta de urgencia, o una negociación explícita — la misma frase puede esconder causas distintas, y cada una necesita una respuesta distinta. Nunca inventes descuentos, condiciones o promesas que no estén en la información del negocio de arriba. Si después de responder el lead sigue sin convencerse, no repitas el mismo argumento — sigue diagnosticando. Si genuinamente no hay fit entre lo que el negocio ofrece y lo que el lead necesita, dilo con honestidad en vez de forzar la venta.

COMPROMISO PROGRESIVO:
No esperes hasta el final de la conversación para intentar avanzar. Construye compromiso con preguntas pequeñas y naturales a lo largo de la conversación (elegir entre opciones, confirmar un problema, indicar un plazo) en vez de acumular preguntas sin aportar nada a cambio. Adapta el tamaño de lo que pides a la confianza que ya existe: si el lead recién te conoce, no le pidas que pague — pídele algo pequeño primero (ver cómo funciona, confirmar una preferencia). Que elija una opción no significa que ya decidió comprar — no lo trates como una venta cerrada. Y si el lead dice que no a algo puntual, acéptalo sin insistir de inmediato con otra pregunta.`;

// PR37 del blueprint de Fase 2 — agrupa los 11 valores de
// Conversation.PSYCHOLOGICAL_STATES en 6 "modos" de doctrina. Mapeo
// groundeado directamente en la fuente, no inventado:
// - docs/modules/Módulo 05 §30 (tabla Estado → Objetivo principal → CREA 10D™)
// - docs/modules/Módulo 06 §29-30 (OBJECIÓN → CREA 10D / OBJECIÓN → PSYCHOLOGICAL STATE)
// - docs/modules/Módulo 07 §20 (MICRO-CLOSING Y PSYCHOLOGICAL STATE)
const PSYCHOLOGICAL_STATE_MODE = {
  UNKNOWN: 'discovery',
  CURIOUS: 'discovery',
  INTERESTED: 'discovery',
  ENGAGED: 'discovery',
  'PROBLEM-AWARE': 'diagnosis',
  'SOLUTION-AWARE': 'diagnosis',
  TRUSTING: 'trust',
  BUYING: 'closing',
  OBJECTING: 'objection_active',
  DECIDING: 'closing',
  PURCHASED: 'post_purchase',
};

const OBJECTION_MICROCLOSING_BY_MODE = {
  // UNKNOWN, CURIOUS, INTERESTED, ENGAGED — Módulo 05 §5-8: objetivo "Detectar y descubrir" / "Descubrir" / "Profundizar".
  discovery: {
    objection: 'Este lead todavía está en una etapa temprana de la conversación. Si menciona una duda o reparo, trátalo como falta de información, no como una objeción de cierre — no actives el árbol de diagnóstico de precio/negociación todavía. Primero termina de entender su necesidad.',
    microClosing: 'No intentes ningún compromiso grande (pago, agendar una compra). Usa solo microcompromisos pequeños de información o preferencia para seguir descubriendo — nada que suene a cierre.',
  },
  // PROBLEM-AWARE, SOLUTION-AWARE — Módulo 05 §9-10: objetivo "Diagnosticar impacto" / "Demostrar por qué la solución tiene sentido".
  diagnosis: {
    objection: 'El lead ya reconoce su problema y está evaluando soluciones. Si presenta una duda, probablemente es sobre si ESTA solución encaja con SU situación — diagnostica antes de argumentar, conectando siempre con el problema específico que ya identificaste, no con características genéricas.',
    microClosing: 'Usa microcompromisos de preferencia y confirmación (elegir entre opciones, validar que entendiste bien el problema) — todavía no pidas una acción de compra.',
  },
  // TRUSTING — Módulo 05 §11: "TRUSTING → Demostrar solución" + reducir fricción.
  trust: {
    objection: 'El lead ya muestra confianza en la empresa y la solución. Si aparece una objeción acá, dale prioridad alta: puede ser lo único que falta para que decida. Diagnostica rápido y resuelve con evidencia concreta, no con frases genéricas de confianza.',
    microClosing: 'Puedes pedir compromisos más grandes que en etapas anteriores (ver una demo, confirmar el siguiente paso) — el nivel de confianza ya lo permite.',
  },
  // OBJECTING — Módulo 05 §13 + Módulo 06 §29: "OBJECTING → Diagnosticar la objeción", conectado a 10D:DESARMAR.
  objection_active: {
    objection: 'Este lead está ACTIVAMENTE en una objeción sin resolver — es la prioridad absoluta de este turno. No avances a demostrar ni a cerrar hasta diagnosticar la causa real (comparación, presupuesto, valor, confianza, urgencia o negociación) y confirmar explícitamente que quedó resuelta antes de seguir.',
    microClosing: 'No pidas ningún compromiso nuevo mientras la objeción siga sin diagnosticar. Como mucho, un microcompromiso puede servir para AISLAR la objeción (ej. "si resolvemos el tema de la inversión, ¿seguirías considerando contratarlo?"), nunca para avanzar hacia el cierre.',
  },
  // BUYING, DECIDING — Módulo 05 §12,14: "BUYING → Reducir fricción" / "DECIDING → Cerrar".
  closing: {
    objection: 'El lead ya muestra intención de compra. Si aparece una objeción, es probable que sea la última barrera antes de cerrar — resuélvela con la mayor rapidez posible, sin reabrir descubrimiento que ya no hace falta.',
    microClosing: 'Reduce fricción: usa compromisos directos hacia la acción final (elegir plan, confirmar método de pago, definir el siguiente paso concreto). Ya no corresponde seguir preguntando por preferencias generales.',
  },
  // PURCHASED — Módulo 05 §15, conectado a 10D:DESARROLLAR (postventa).
  post_purchase: {
    objection: 'Este lead ya compró — cualquier duda ahora es de postventa, no una objeción comercial. Trátala como soporte y acompañamiento, no como una barrera que hay que superar.',
    microClosing: 'No apliques micro-closing comercial acá. El objetivo es acompañamiento, satisfacción, y detectar oportunidades futuras de recompra o referidos — no avanzar hacia una nueva venta inmediata.',
  },
};

/**
 * Construye el bloque de MANEJO DE OBJECIONES + COMPROMISO PROGRESIVO —
 * dinámico (PR37) cuando hay suficiente leadQualification real, con
 * fallback al texto estático de PR34 en cualquier otro caso.
 *
 * Señales usadas, en orden — documentado acá para que quede trazable de
 * dónde sale cada condición (ver también el PR body):
 * 1. psychologicalState → selecciona uno de 6 "modos" (tabla
 *    PSYCHOLOGICAL_STATE_MODE arriba). Es la señal PRIMARIA — sin un
 *    psychologicalState reconocido, se usa el fallback estático completo,
 *    sin importar qué otros campos de leadQualification sí existan.
 * 2. intent === 'not_interested' → agrega una nota de honestidad/no-fit
 *    (Módulo 06 §40 "Objeciones no siempre deben ser superadas"),
 *    independiente del modo elegido por psychologicalState.
 * 3. score (si es un número 0-100) → agrega UNA nota de ritmo, mutuamente
 *    excluyente: score < 40 → conservador; score >= 80 → priorizar avance.
 *    Entre 40 y 80 no agrega nada (no todo tiene que generar una nota).
 * budget/timeline quedan disponibles en leadQualification pero
 * deliberadamente NO se usan para condicionar texto en este PR — con
 * psychologicalState + intent + score ya alcanza para el matiz que hace
 * falta, y sumar más ejes hoy sería combinatoria sin payoff claro.
 */
const buildObjectionMicroClosingGuidance = (leadQualification) => {
  const mode = leadQualification?.psychologicalState
    ? PSYCHOLOGICAL_STATE_MODE[leadQualification.psychologicalState]
    : undefined;

  if (!mode) return STATIC_OBJECTION_MICROCLOSING_GUIDANCE;

  const { objection, microClosing } = OBJECTION_MICROCLOSING_BY_MODE[mode];
  const notas = [];

  if (leadQualification.intent === 'not_interested') {
    notas.push('El lead fue clasificado con intención "not_interested" — prioriza la honestidad sobre seguir vendiendo; si genuinamente no hay fit entre lo que ofrece el negocio y lo que el lead necesita, dilo con claridad en vez de forzar la conversación hacia una venta.');
  }

  if (typeof leadQualification.score === 'number') {
    if (leadQualification.score < 40) {
      notas.push(`El score de calificación es bajo (${leadQualification.score}/100) — sé conservador con el ritmo, prioriza seguir entendiendo antes de acelerar hacia un compromiso mayor.`);
    } else if (leadQualification.score >= 80) {
      notas.push(`El score de calificación es alto (${leadQualification.score}/100) — prioriza avanzar, evita repetir descubrimiento que ya quedó cubierto.`);
    }
  }

  return `MANEJO DE OBJECIONES:
${objection}

COMPROMISO PROGRESIVO:
${microClosing}${notas.length ? `\n\n${notas.join('\n')}` : ''}`;
};

const buildSystemPrompt = (business, lead, leadQualification) => {
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
7. Nunca menciones que eres una IA a menos que te lo pregunten directamente

${METHODOLOGY_10D_GUIDANCE}

${buildObjectionMicroClosingGuidance(leadQualification)}`;
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
 * Si el lead mandó una imagen/video (`media`), esta función también la
 * descarga de la URL temporal que trae el payload de Gupshup y la
 * re-aloja en Cloudinary (mismo storage y mismo shape que ya usa el envío
 * SALIENTE de media — mediaUrl/mediaType en el mensaje) — ANTES de este
 * fix, cualquier imagen/video entrante se descartaba por completo en
 * parseGupshupPayload() (solo reconocía `msg.type === 'text'`), y como
 * mucho sobrevivía el caption si lo traía (guardado como si fuera un
 * mensaje de puro texto). Fail-soft a propósito: si la descarga/re-alojo
 * falla (URL ya expirada, WhatsAppChannel caído, etc.), el mensaje se
 * guarda igual con el caption/placeholder — nunca se pierde el mensaje
 * completo solo porque la media no se pudo procesar.
 *
 * @param {string} conversationId
 * @param {string} text
 * @param {{ mediaType: 'image'|'video', sourceUrl: string }} [media] URL
 *   TEMPORAL de Gupshup — nunca se guarda tal cual, se re-aloja primero.
 * @returns {Promise<import('./conversation.model')>} la conversación actualizada
 */
const saveInboundMessage = async (conversationId, text, media) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  const mensaje = {
    role: 'user',
    content: text || (media ? (media.mediaType === 'video' ? '[Video]' : '[Imagen]') : ''),
    timestamp: new Date(),
    // Explícito — sin esto, el default del schema ('ai') dejaba un mensaje
    // del LEAD indistinguible de una respuesta real de la IA para
    // cualquiera que mire sentBy sin filtrar por role primero.
    sentBy: 'lead',
  };

  if (media?.sourceUrl) {
    try {
      const channel = await channelService.getChannelForConversation(conversation, conversation.business);
      if (!channel) {
        throw new Error(`Ningún WhatsAppChannel activo para el tenant ${conversation.business}`);
      }
      const { buffer } = await channelService.downloadMedia(channel._id, media.sourceUrl);
      const resultado = await cloudinaryUtil.subirBuffer(buffer, {
        folder: `creaos/conversations/${conversationId}/media`,
        resource_type: media.mediaType,
      });
      mensaje.mediaUrl = resultado.secure_url;
      mensaje.mediaType = media.mediaType;
    } catch (error) {
      logger.error(`No se pudo descargar/re-alojar media entrante (conversación ${conversationId}): ${error.message}`);
    }
  }

  conversation.messages.push(mensaje);
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
 *
 * Tool calling (escalate_to_human, ver ./tools): cada vuelta manda
 * `tools: TOOL_SCHEMAS` a OpenAI. Si el modelo responde SIN tool_calls (la
 * inmensa mayoría de los casos — cualquier respuesta de texto normal), el
 * comportamiento es exactamente el de antes de este cambio: un solo
 * request, un solo mensaje assistant guardado, mismo return. Si el modelo
 * SÍ pide una tool, se ejecuta vía executeToolCall() (nunca lanza — ver
 * ./tools), se guarda el intercambio completo (mensaje del assistant con
 * toolCalls + mensaje(s) role:'tool' con el resultado) y se vuelve a
 * llamar a OpenAI con ese contexto extra, hasta que responda con texto
 * final o se llegue a MAX_TOOL_ITERATIONS. Un solo `conversation.save()`
 * al final (cuando ya hay texto final que devolver) — nunca saves
 * parciales a mitad del loop.
 */
const generateReply = async (conversationId, business, lead) => {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation) throw new AppError('Conversación no encontrada', 404);

  // PR37 del blueprint de Fase 2 — pasa la calificación real ya persistida
  // (PR35/36) para que buildSystemPrompt() pueda condicionar Objection/
  // Micro-Closing. conversation.leadQualification viene undefined en
  // conversaciones nuevas (antes del primer qualifyLead() automático) —
  // buildSystemPrompt()/buildObjectionMicroClosingGuidance() lo manejan
  // como fallback al bloque estático, no como error.
  const systemPrompt = buildSystemPrompt(business, lead, conversation.leadQualification);
  const recentMessages = conversation.messages.slice(-10).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // apiMessages es lo que efectivamente se manda a OpenAI en cada vuelta —
  // arranca igual que siempre (system + últimos 10) y solo crece si el
  // modelo pide ejecutar una tool.
  const apiMessages = [{ role: 'system', content: systemPrompt }, ...recentMessages];

  // PR39 — decidido UNA sola vez por llamada a generateReply(), antes del
  // loop, no en cada iteración: todas las vueltas de un mismo turno usan
  // el mismo modelo (evita cambiar de modelo a mitad de un intercambio de
  // tool calling, que no aporta nada y solo agrega variabilidad). Con
  // AI_MODEL_ROUTING_ENABLED en false, selectModel() devuelve OPENAI_MODEL
  // siempre — ver comentario completo de la heurística arriba.
  const selectedModel = selectModel(conversation, conversation.leadQualification, recentMessages);

  let totalTokensUsed = 0;

  for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration += 1) {
    const completion = await openai.chat.completions.create({
      model: selectedModel,
      messages: apiMessages,
      max_tokens: AI_MAX_TOKENS,
      temperature: AI_TEMPERATURE,
      tools: TOOL_SCHEMAS,
    });

    const promptTokens = completion.usage?.prompt_tokens || 0;
    const completionTokens = completion.usage?.completion_tokens || 0;
    totalTokensUsed += completion.usage?.total_tokens || (promptTokens + completionTokens);

    const message = completion.choices[0].message;

    // Camino SIN tool_calls — idéntico al comportamiento anterior a este
    // cambio: se guarda como único mensaje assistant del turno y se
    // retorna igual que siempre.
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const reply = message.content;

      conversation.messages.push({
        role: 'assistant',
        content: reply,
        timestamp: new Date(),
        tokens: totalTokensUsed,
        // Desglose prompt/completion para costo exacto (ver config/aiPricing.js).
        // Mensajes anteriores a este cambio no lo tienen — el cálculo de costo cae
        // a una tarifa combinada estimada para esos casos. model: selectedModel
        // (no OPENAI_MODEL fijo) desde PR39 — con model routing activo, el
        // modelo real usado en ESTE mensaje puede ser el barato; grabar
        // siempre OPENAI_MODEL acá haría que aiPricing.js#getPricing()
        // calculara el costo con la tarifa equivocada para esos mensajes.
        metadata: { promptTokens, completionTokens, model: selectedModel },
      });
      conversation.totalTokensUsed += totalTokensUsed;
      await conversation.save();

      return { reply, tokensUsed: totalTokensUsed, conversationId: conversation._id };
    }

    // El modelo pidió ejecutar 1+ tools antes de responder — se guarda el
    // mensaje del assistant que las pidió (content puede venir vacío/null
    // de OpenAI cuando el turno es solo tool_calls; ver default:'' en el
    // schema) y se ejecuta cada tool call en orden.
    apiMessages.push({ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls });
    conversation.messages.push({
      role: 'assistant',
      content: message.content || '',
      timestamp: new Date(),
      toolCalls: message.tool_calls,
      // Mismo motivo que el metadata de arriba: selectedModel, no
      // OPENAI_MODEL fijo (PR39).
      metadata: { promptTokens, completionTokens, model: selectedModel },
    });

    for (const toolCall of message.tool_calls) {
      // eslint-disable-next-line no-await-in-loop -- cada tool call depende
      // del estado que dejó la anterior (ej. conversation.status), deben
      // ejecutarse en orden, no en paralelo.
      const result = await executeToolCall(toolCall, { conversation, business, lead });
      const resultContent = JSON.stringify(result);

      apiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultContent });
      conversation.messages.push({
        role: 'tool',
        content: resultContent,
        timestamp: new Date(),
        toolCallId: toolCall.id,
        name: toolCall.function?.name,
      });
    }
    // No hay save acá a propósito — sigue al siguiente `for` con el
    // resultado de la tool ya en apiMessages, hasta que el modelo responda
    // con texto final (arriba) o se agoten las iteraciones.
  }

  // Solo se llega acá si el modelo siguió pidiendo tools sin converger a
  // una respuesta de texto en MAX_TOOL_ITERATIONS vueltas — no debería
  // pasar en uso normal (ver comentario de MAX_TOOL_ITERATIONS).
  throw new AppError('El agente no pudo completar la respuesta (demasiadas tool calls encadenadas)', 500);
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
  "notes": <observaciones clave en 1-2 oraciones>,
  "psychologicalState": <uno de estos 11 valores exactos, el que mejor describa el estado ACTUAL del comprador: "UNKNOWN" | "CURIOUS" | "INTERESTED" | "ENGAGED" | "PROBLEM-AWARE" | "SOLUTION-AWARE" | "TRUSTING" | "BUYING" | "OBJECTING" | "DECIDING" | "PURCHASED">
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

  // Fail-soft a propósito, mismo criterio que executeToolCall()/
  // saveInboundMessage(): psychologicalState tiene 11 valores posibles (a
  // diferencia de temperature/intent, con 3-4), más superficie para que el
  // modelo devuelva algo fuera de forma (typo, guion bajo en vez de guion,
  // minúsculas). Si eso pasa, el enum de conversation.model.js igual lo
  // rechazaría en el conversation.save() de abajo y tumbaría qualifyLead()
  // ENTERO — incluyendo score/temperature/intent, que sí venían bien. Mejor
  // descartar solo el campo problemático que perder toda la calificación.
  if (qualification.psychologicalState && !Conversation.PSYCHOLOGICAL_STATES.includes(qualification.psychologicalState)) {
    logger.warn(`qualifyLead(): psychologicalState fuera de los 11 valores esperados, se descarta: ${qualification.psychologicalState}`);
    delete qualification.psychologicalState;
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
      // PR-10a: resuelve por conversation.whatsappChannel cuando está
      // poblado (el canal que RECIBIÓ el mensaje del lead) — con 1 solo
      // canal activo (100% de la base hoy) es idéntico a
      // getChannelForTenant() de siempre.
      const channel = await channelService.getChannelForConversation(conversation, conversation.business);
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
    // PR-10a: mismo criterio que sendAgentMessage() — resuelve por
    // conversation.whatsappChannel cuando está poblado.
    const channel = await channelService.getChannelForConversation(conversation, conversation.business);
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
    // PR-10a: mismo criterio que sendAgentMessage()/sendTemplateMessage().
    const channel = await channelService.getChannelForConversation(conversation, conversation.business);
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

module.exports = {
  buildSystemPrompt, chat, saveInboundMessage, generateReply, qualifyLead, generateSummary,
  suggestResponse, sendAgentMessage, sendTemplateMessage, sendMediaMessage,
  // Exportado únicamente para tests: este repo no tiene un framework de
  // mocks (ver convención de "referencia viva" en los comentarios de
  // arriba) — sin exponer el cliente real de OpenAI, no hay forma de
  // interceptar openai.chat.completions.create() desde un script de test
  // externo para simular una respuesta con tool_calls sin pegarle a la API
  // real. No se usa en ningún otro lado del código de producción.
  openai,
};
