// Test real (Jest, Mongo real) de ai.service.js#generateReply() — CREA
// SALES AI™ C.2, Etapa 7/11 (fallback + handoff explícito). Mismo criterio
// exacto que ai.service.generateReply.productIntelligence.test.js: simula
// la conversación COMPLETA a través del loop real de tool-calling
// (openai.chat.completions.create() mockeado con una secuencia de
// respuestas), para probar que las piezas YA CONSTRUIDAS en las Etapas
// 2-6 (knowledgeRetrieval.service.js, search_business_knowledge,
// BUSINESS_KNOWLEDGE_GUIDANCE, escalate_to_human ya existente de PR33)
// encadenan correctamente de punta a punta — sin código nuevo más allá de
// estos tests, tal como anticipó el plan de la Etapa 7
// (docs/implementation/c2-policies-faq-current-state.md, sección 7).
//
// Cubre los 2 casos de aceptación de esta etapa (documento §23):
// TC-09 (Policy con responseMode:'handoff' → debe activar escalate_to_human)
// y TC-07 (sin evidencia real → debe usar fallback, nunca inventar).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Policy = require('../business-knowledge/policy.model');
const Conversation = require('./conversation.model');

// Bloque 3 (§53, 20/sep/2026) — search_business_knowledge ahora pide un
// embedding real de la query (retrieval semántico) — se mockea para no
// pegarle a OpenAI en este suite (foco: el loop de tool-calling end-to-end,
// no el retrieval semántico en sí, que tiene su propio test dedicado).
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_business_knowledge_handoff';

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

describe('ai.service#generateReply() — CREA SALES AI™ C.2 (fallback + handoff, documento §23)', () => {
  let business;
  let lead;
  let conversation;
  let createSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const ultimoMensajeTool = async (nombreTool) => {
    const guardada = await Conversation.findById(conversation._id);
    const msgs = guardada.messages.filter((m) => m.role === 'tool' && m.name === nombreTool);
    return JSON.parse(msgs[msgs.length - 1].content);
  };

  test('TC-09 — Policy con responseMode:"handoff": el agente encadena search_business_knowledge → escalate_to_human con el handoffReason real', async () => {
    await Policy.create({
      business: business._id,
      code: 'COMPLAINT-001',
      title: 'Reclamo formal',
      category: 'complaints',
      policyType: 'handoff',
      statement: 'Los reclamos formales requieren gestión de un agente humano, nunca resolución automática.',
      status: 'active',
      action: {
        responseMode: 'handoff',
        handoffReason: 'El lead presentó un reclamo formal que requiere gestión humana.',
        requiresHumanApproval: true,
      },
    });

    conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: 'Quiero hacer un reclamo formal por mi pedido' }],
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'reclamo formal' })]))
      .mockResolvedValueOnce(completionConToolCalls([
        toolCallMock('call_2', 'escalate_to_human', { reason: 'El lead presentó un reclamo formal que requiere gestión humana.' }),
      ]))
      .mockResolvedValueOnce(completionFinal('Entiendo tu reclamo — te voy a derivar con un agente humano para que lo gestione directamente.'));

    const resultado = await aiService.generateReply(conversation._id, business, lead);

    expect(resultado.reply).toBe('Entiendo tu reclamo — te voy a derivar con un agente humano para que lo gestione directamente.');
    expect(createSpy).toHaveBeenCalledTimes(3);

    // La tool ya trae responseMode/handoffReason tal cual la Policy — el
    // "contrato de handoff" (documento §15) no requiere ningún código nuevo,
    // solo que este campo llegue intacto al modelo.
    const busqueda = await ultimoMensajeTool('search_business_knowledge');
    expect(busqueda.policies[0]).toMatchObject({
      code: 'COMPLAINT-001',
      responseMode: 'handoff',
      handoffReason: 'El lead presentó un reclamo formal que requiere gestión humana.',
    });

    const escalamiento = await ultimoMensajeTool('escalate_to_human');
    expect(escalamiento).toMatchObject({ success: true, alreadyEscalated: false });

    // Efecto real: la conversación queda escalada — escalate_to_human (PR33,
    // ya existente) es el ÚNICO mecanismo que lo hace, sin Action Engine nuevo.
    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.status).toBe('escalated');
    expect(guardada.aiEnabled).toBe(false);
    expect(guardada.escalatedAt).toBeTruthy();
  });

  test('TC-07 — sin evidencia real: el agente usa fallback (no inventa), y NO escala si no hace falta', async () => {
    // Catálogo de conocimiento vacío a propósito — ninguna Policy/FAQ sobre
    // "garantía de por vida" en este negocio.
    conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: '¿Tienen garantía de por vida en sus productos?' }],
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'garantía de por vida' })]))
      .mockResolvedValueOnce(completionFinal('No tengo esa información confirmada ahora mismo — dejame consultarlo con el equipo y te aviso.'));

    const resultado = await aiService.generateReply(conversation._id, business, lead);

    expect(resultado.reply).toBe('No tengo esa información confirmada ahora mismo — dejame consultarlo con el equipo y te aviso.');
    expect(createSpy).toHaveBeenCalledTimes(2);

    const busqueda = await ultimoMensajeTool('search_business_knowledge');
    expect(busqueda).toEqual({
      success: true,
      policies: [],
      faqs: [],
      documentChunks: [],
      conflictDetected: false,
      needsClarification: false,
    });

    // Sin handoff forzado — el fallback textual alcanzó, no todo "no
    // encontrado" implica escalar (documento §23 TC-07 vs TC-09, casos
    // distintos a propósito).
    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.status).not.toBe('escalated');
    expect(guardada.aiEnabled).toBe(true);
  });
});
