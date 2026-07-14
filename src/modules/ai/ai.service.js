const OpenAI = require('openai');
const { OPENAI_API_KEY, OPENAI_MODEL, AI_MAX_TOKENS, AI_TEMPERATURE } = require('../../config/env');
const Conversation = require('./conversation.model');
const Lead = require('../leads/lead.model');
const { AppError } = require('../../middleware/error.middleware');

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

module.exports = { buildSystemPrompt, chat, qualifyLead, generateSummary, suggestResponse };
