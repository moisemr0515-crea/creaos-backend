// Test real (Jest, Mongo real) de ai.service.js#generateReply() — CREA
// SALES AI™ C.2, Etapa 10/11 (pruebas de integración multi-tenant
// end-to-end). Mismo patrón EXACTO que
// ai.service.generateReply.multiTenant.test.js (Product Intelligence,
// Etapa 9/10) — cierra el mismo hueco de cobertura pero para
// Policy/FAQ: los tests existentes prueban aislamiento en capas AISLADAS
// (policy.service.test.js/faq.service.test.js a nivel service,
// knowledgeRetrieval.service.test.js/.precedence.test.js a nivel
// retrieval, ai/tools/index.businessKnowledge.test.js a nivel
// executeToolCall() directo) — pero ninguno corre el LOOP COMPLETO de
// generateReply() (search_business_knowledge vía OpenAI mockeado) para 2
// negocios distintos en el mismo test.
//
// Escenario del documento §34/TC-06 llevado a generateReply() real: mismo
// `code`/`question`, contenido distinto por negocio, cada conversación
// debe responder solo con lo suyo.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Policy = require('../business-knowledge/policy.model');
const FAQ = require('../business-knowledge/faq.model');
const Conversation = require('./conversation.model');

// Bloque 3 (§53, 20/sep/2026) — mismo motivo que
// ai.service.generateReply.businessKnowledgeHandoff.test.js.
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_business_knowledge_multi_tenant';

const toolCallMock = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const completionConToolCalls = (toolCalls) => ({
  choices: [{ message: { content: '', tool_calls: toolCalls } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const completionFinal = (content) => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const crearConversacion = async (business, mensajeInicial) => {
  const lead = await Lead.create({ business: business._id, name: 'Lead de prueba' });
  const conversation = await Conversation.create({
    business: business._id,
    lead: lead._id,
    channel: 'whatsapp',
    messages: [{ role: 'user', content: mensajeInicial }],
  });
  return { lead, conversation };
};

const ultimoMensajeTool = async (conversationId, nombreTool) => {
  const guardada = await Conversation.findById(conversationId);
  const msgs = guardada.messages.filter((m) => m.role === 'tool' && m.name === nombreTool);
  return JSON.parse(msgs[msgs.length - 1].content);
};

describe('ai.service#generateReply() — Business Brain, aislamiento multi-tenant end-to-end (documento §34)', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
  });

  test('mismo CODE de Policy en 2 negocios, statement distinto — cada conversación responde solo con el suyo', async () => {
    const negocioA = await Business.create({ name: 'Negocio A' });
    const negocioB = await Business.create({ name: 'Negocio B' });

    await Policy.create({
      business: negocioA._id,
      code: 'RETURNS-001',
      title: 'Cambios y devoluciones',
      category: 'returns',
      policyType: 'rule',
      statement: 'Se aceptan devoluciones dentro de 7 días.',
      status: 'active',
    });
    await Policy.create({
      business: negocioB._id,
      code: 'RETURNS-001',
      title: 'Cambios y devoluciones',
      category: 'returns',
      policyType: 'rule',
      statement: 'Se aceptan devoluciones dentro de 30 días.',
      status: 'active',
    });

    const { lead: leadA, conversation: conversationA } = await crearConversacion(negocioA, '¿Cuál es la política de devoluciones?');
    const { lead: leadB, conversation: conversationB } = await crearConversacion(negocioB, '¿Cuál es la política de devoluciones?');

    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    // --- Turno completo para el Negocio A ---
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_a1', 'search_business_knowledge', { query: 'política de devoluciones' })]))
      .mockResolvedValueOnce(completionFinal('Aceptamos devoluciones dentro de 7 días.'));

    const resultadoA = await aiService.generateReply(conversationA._id, negocioA, leadA);
    expect(resultadoA.reply).toBe('Aceptamos devoluciones dentro de 7 días.');

    const busquedaA = await ultimoMensajeTool(conversationA._id, 'search_business_knowledge');
    expect(busquedaA.policies).toHaveLength(1);
    expect(busquedaA.policies[0].statement).toBe('Se aceptan devoluciones dentro de 7 días.');

    // --- Turno completo para el Negocio B, INMEDIATAMENTE después (mismo
    // proceso, mismo módulo aiService ya "usado") ---
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_b1', 'search_business_knowledge', { query: 'política de devoluciones' })]))
      .mockResolvedValueOnce(completionFinal('Aceptamos devoluciones dentro de 30 días.'));

    const resultadoB = await aiService.generateReply(conversationB._id, negocioB, leadB);
    expect(resultadoB.reply).toBe('Aceptamos devoluciones dentro de 30 días.');

    const busquedaB = await ultimoMensajeTool(conversationB._id, 'search_business_knowledge');
    expect(busquedaB.policies).toHaveLength(1);
    expect(busquedaB.policies[0].statement).toBe('Se aceptan devoluciones dentro de 30 días.');

    // Verificación cruzada explícita: ningún statement se filtró al otro
    // negocio, pese a compartir el mismo `code`.
    expect(busquedaA.policies[0].statement).not.toBe(busquedaB.policies[0].statement);
  });

  test('misma QUESTION de FAQ en 2 negocios, answer distinta — cada conversación responde solo con la suya', async () => {
    const negocioA = await Business.create({ name: 'Negocio A' });
    const negocioB = await Business.create({ name: 'Negocio B' });

    await FAQ.create({
      business: negocioA._id,
      question: '¿Aceptan Yape?',
      answer: 'Sí, aceptamos Yape.',
      category: 'payments',
      status: 'active',
    });
    await FAQ.create({
      business: negocioB._id,
      question: '¿Aceptan Yape?',
      answer: 'No, todavía no aceptamos Yape, solo transferencia bancaria.',
      category: 'payments',
      status: 'active',
    });

    const { lead: leadA, conversation: conversationA } = await crearConversacion(negocioA, '¿Aceptan Yape?');
    const { lead: leadB, conversation: conversationB } = await crearConversacion(negocioB, '¿Aceptan Yape?');

    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_a1', 'search_business_knowledge', { query: 'aceptan yape' })]))
      .mockResolvedValueOnce(completionFinal('Sí, aceptamos Yape.'));
    const resultadoA = await aiService.generateReply(conversationA._id, negocioA, leadA);
    expect(resultadoA.reply).toBe('Sí, aceptamos Yape.');

    const busquedaA = await ultimoMensajeTool(conversationA._id, 'search_business_knowledge');
    expect(busquedaA.faqs).toHaveLength(1);
    expect(busquedaA.faqs[0].answer).toBe('Sí, aceptamos Yape.');

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_b1', 'search_business_knowledge', { query: 'aceptan yape' })]))
      .mockResolvedValueOnce(completionFinal('No, todavía no aceptamos Yape, solo transferencia bancaria.'));
    const resultadoB = await aiService.generateReply(conversationB._id, negocioB, leadB);
    expect(resultadoB.reply).toBe('No, todavía no aceptamos Yape, solo transferencia bancaria.');

    const busquedaB = await ultimoMensajeTool(conversationB._id, 'search_business_knowledge');
    expect(busquedaB.faqs).toHaveLength(1);
    expect(busquedaB.faqs[0].answer).toBe('No, todavía no aceptamos Yape, solo transferencia bancaria.');

    expect(busquedaA.faqs[0].answer).not.toBe(busquedaB.faqs[0].answer);
  });

  test('cero cruce: la Policy/FAQ de un negocio NUNCA aparece en el resultado del otro, aunque el negocio consultante no tenga ninguna propia', async () => {
    const negocioConContenido = await Business.create({ name: 'Negocio con contenido' });
    const negocioVacio = await Business.create({ name: 'Negocio vacío' });

    await Policy.create({
      business: negocioConContenido._id,
      code: 'WARRANTY-001',
      title: 'Garantía',
      category: 'warranty',
      policyType: 'rule',
      statement: 'Todos los productos tienen 1 año de garantía.',
      status: 'active',
    });
    await FAQ.create({
      business: negocioConContenido._id,
      question: '¿Tienen garantía?',
      answer: 'Sí, 1 año de garantía.',
      category: 'warranty',
      status: 'active',
    });

    const { lead, conversation } = await crearConversacion(negocioVacio, '¿Tienen garantía?');

    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'garantía' })]))
      .mockResolvedValueOnce(completionFinal('No tengo esa información confirmada ahora mismo — dejame consultarlo con el equipo.'));

    const resultado = await aiService.generateReply(conversation._id, negocioVacio, lead);
    expect(resultado.reply).toBe('No tengo esa información confirmada ahora mismo — dejame consultarlo con el equipo.');

    const busqueda = await ultimoMensajeTool(conversation._id, 'search_business_knowledge');
    expect(busqueda).toEqual({
      success: true,
      policies: [],
      faqs: [],
      documentChunks: [],
      conflictDetected: false,
      needsClarification: false,
    });
  });
});
