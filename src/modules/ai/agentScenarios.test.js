// Scenario Library — CREA SALES AI™ C.3, Etapa C3.5 (Evaluation Harness,
// docs/architecture-runtime/CREA_SALES_AI_C3_..., §8). Los 10 escenarios
// mínimos que pide la spec, ejecutados vía runAgent() — el runtime REAL
// (Etapas C3.1-C3.4), no un mock del cerebro. No es un framework de evals
// nuevo: son tests de Jest, mismo patrón que
// ai.service.generateReply.*.test.js (OpenAI mockeado en el límite exacto
// de la API externa, loop de tool-calling real, Mongo real, RBAC/tenant
// resolution reales). El valor de este archivo frente a la cobertura ya
// existente (C.2/C3.1-C3.4) es tener los 10 casos de aceptación de la
// spec en UN SOLO lugar, con forma uniforme (AgentScenario: fixture de
// tenant + conversación + outcome esperado + tools esperadas), en vez de
// dispersos entre archivos de distintas etapas — sirve como suite de
// regresión reproducible para MEDIR comportamiento del cerebro, no para
// "entrenar" nada (spec §8: "no se exige entrenar el modelo en C.3, se
// exige medir comportamiento").
//
// Alcance honesto de lo que SÍ y NO se puede probar mockeando OpenAI:
// se puede probar que el runtime/las tools NUNCA inventan un dato que no
// vino de Mongo (Product/Policy/FAQ reales), que el aislamiento
// multi-tenant se sostiene, que una tool que falla no tumba el turno, y
// que el `outcome` se deriva correctamente de señales reales. NO se
// puede probar (sin pegarle a la API real) si un modelo de verdad
// elegiría usar una tool o qué texto exacto redactaría — eso es
// responsabilidad de OpenAI, no de este runtime (misma limitación que ya
// documentan los tests de Product Intelligence).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const Policy = require('../business-knowledge/policy.model');
const FAQ = require('../business-knowledge/faq.model');
const Conversation = require('./conversation.model');

// Bloque 3 (§53, 20/sep/2026) — search_business_knowledge ahora pide un
// embedding real de la query (retrieval semántico) — se mockea para no
// pegarle a OpenAI en este suite de escenarios.
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_agent_scenarios';

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

describe('CREA SALES AI™ — Scenario Library (C.3, Etapa C3.5, spec §8)', () => {
  let business;
  let lead;
  let createSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const crearConversacion = async (mensajeInicial, businessOverride) =>
    Conversation.create({
      business: (businessOverride || business)._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: mensajeInicial }],
    });

  /**
   * Harness mínimo (spec §8: AgentScenario) — ejecuta el turno REAL vía
   * runAgent() con las respuestas de OpenAI ya encoladas, y hace las
   * asserts comunes a todo escenario. No abstrae la construcción de la
   * fixture (varía demasiado entre los 10 casos para que valga la pena
   * forzar una tabla genérica) — sí abstrae la ejecución + verificación,
   * que es idéntica siempre.
   */
  const ejecutarEscenario = async ({ conversation, negocio, completions, expectedOutcome, expectedTools }) => {
    completions.forEach((c) => createSpy.mockResolvedValueOnce(c));

    const resultado = await aiService.runAgent({ conversationId: conversation._id, business: negocio || business, lead });

    expect(resultado.outcome).toBe(expectedOutcome);
    if (expectedTools) {
      expect(resultado.toolsUsed.sort()).toEqual([...expectedTools].sort());
    }
    return resultado;
  };

  test('Escenario 1 — consulta solo de producto: search_products responde con datos reales del catálogo', async () => {
    const producto = await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa', keywords: ['moringa'], price: 50, physicalStock: 10 });
    const conversation = await crearConversacion('¿Tienen moringa?');

    const resultado = await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]),
        completionFinal('Sí, tenemos Moringa a S/50.'),
      ],
      expectedOutcome: 'answer',
      expectedTools: ['search_products'],
    });

    expect(resultado.knowledgeSources).toEqual(['product_catalog']);
    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.activeProduct.productId.toString()).toBe(producto._id.toString());
  });

  test('Escenario 2 — consulta solo de Policy/FAQ: search_business_knowledge responde con la Policy real', async () => {
    await Policy.create({
      business: business._id,
      code: 'RETURNS-001',
      title: 'Devoluciones',
      category: 'returns',
      policyType: 'rule',
      statement: 'Se aceptan devoluciones dentro de 7 días.',
      status: 'active',
    });
    const conversation = await crearConversacion('¿Cuál es la política de devoluciones?');

    const resultado = await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'devoluciones' })]),
        completionFinal('Aceptamos devoluciones dentro de 7 días.'),
      ],
      expectedOutcome: 'answer',
      expectedTools: ['search_business_knowledge'],
    });

    expect(resultado.knowledgeSources).toEqual(['policy:RETURNS-001']);
  });

  test('Escenario 3 — consulta mixta producto + política: combina las 2 fuentes sin confundirlas (TC-11)', async () => {
    const producto = await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa', keywords: ['moringa'], price: 50 });
    await Policy.create({
      business: business._id,
      code: 'WARRANTY-MOR',
      title: 'Garantía Moringa',
      category: 'warranty',
      policyType: 'rule',
      statement: 'La Moringa tiene 1 año de garantía.',
      status: 'active',
      scope: { appliesToAll: false, productIds: [producto._id] },
    });
    const conversation = await crearConversacion('¿Cuánto cuesta la moringa y tiene garantía?');

    const resultado = await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]),
        completionConToolCalls([
          toolCallMock('call_2', 'get_price', { productId: producto._id.toString() }),
          toolCallMock('call_3', 'search_business_knowledge', { query: 'garantía' }),
        ]),
        completionFinal('Cuesta S/50 y tiene 1 año de garantía.'),
      ],
      expectedOutcome: 'answer',
      expectedTools: ['search_products', 'get_price', 'search_business_knowledge'],
    });

    expect(resultado.knowledgeSources.sort()).toEqual(['product_catalog', 'policy:WARRANTY-MOR'].sort());
  });

  test('Escenario 4 — información faltante: la tool devuelve vacío real, nunca un dato inventado', async () => {
    // Catálogo de conocimiento vacío a propósito.
    const conversation = await crearConversacion('¿Tienen garantía de por vida?');

    const resultado = await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'garantía de por vida' })]),
        completionFinal('No tengo esa información confirmada ahora mismo, dejame consultarlo con el equipo.'),
      ],
      expectedOutcome: 'answer',
      expectedTools: ['search_business_knowledge'],
    });

    // La ÚNICA fuente de verdad de "no hay info" es lo que Mongo devolvió
    // realmente — nunca el runtime rellenando algo por su cuenta.
    expect(resultado.knowledgeSources).toEqual([]);
  });

  test('Escenario 5 — ambigüedad: needsClarification real (TC-08) deriva a outcome:"clarify", nunca elige al azar', async () => {
    const producto = await Product.create({ business: business._id, sku: 'X', name: 'Producto X' });
    await Policy.create({ business: business._id, code: 'RETURNS-GENERAL', title: 'Cambios generales', category: 'returns', policyType: 'rule', statement: 'Cambios hasta 7 días.', status: 'active', scope: { appliesToAll: true } });
    await Policy.create({ business: business._id, code: 'RETURNS-X', title: 'Cambios Producto X', category: 'returns', policyType: 'exception', statement: 'Producto X no admite cambios.', status: 'active', scope: { appliesToAll: false, productIds: [producto._id] } });
    const conversation = await crearConversacion('¿Puedo hacer un cambio?');

    await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'cambios' })]),
        completionFinal('¿Sobre qué producto querés hacer el cambio?'),
      ],
      expectedOutcome: 'clarify',
      expectedTools: ['search_business_knowledge'],
    });
  });

  test('Escenario 6 — handoff obligatorio: escalate_to_human muta la conversación real, outcome:"handoff"', async () => {
    const conversation = await crearConversacion('Quiero hacer un reclamo formal');

    await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'escalate_to_human', { reason: 'Reclamo formal, requiere gestión humana.' })]),
        completionFinal('Te voy a derivar con un agente humano.'),
      ],
      expectedOutcome: 'handoff',
      expectedTools: ['escalate_to_human'],
    });

    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.status).toBe('escalated');
    expect(guardada.aiEnabled).toBe(false);
  });

  test('Escenario 7 — intento cross-tenant: mismo SKU en 2 negocios, cada uno ve SOLO el suyo', async () => {
    const negocioB = await Business.create({ name: 'Negocio B', currency: 'PEN' });
    const leadB = await Lead.create({ business: negocioB._id, name: 'Lead de B' });

    await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa', keywords: ['moringa'], price: 50 });
    await Product.create({ business: negocioB._id, sku: 'MOR-001', name: 'Moringa', keywords: ['moringa'], price: 999 });

    const conversationA = await crearConversacion('¿Tienen moringa?');
    const resultadoA = await ejecutarEscenario({
      conversation: conversationA,
      completions: [
        completionConToolCalls([toolCallMock('call_a1', 'search_products', { query: 'moringa' })]),
        completionFinal('Sí, tenemos moringa a S/50.'),
      ],
      expectedOutcome: 'answer',
    });

    const toolMsgA = (await Conversation.findById(conversationA._id)).messages.find((m) => m.role === 'tool' && m.name === 'search_products');
    expect(JSON.parse(toolMsgA.content).matches[0].price).toBe(50);
    expect(resultadoA.toolsUsed).toEqual(['search_products']);

    const conversationB = await Conversation.create({ business: negocioB._id, lead: leadB._id, channel: 'whatsapp', messages: [{ role: 'user', content: '¿Tienen moringa?' }] });
    await ejecutarEscenario({
      conversation: conversationB,
      negocio: negocioB,
      completions: [
        completionConToolCalls([toolCallMock('call_b1', 'search_products', { query: 'moringa' })]),
        completionFinal('Sí, tenemos moringa a S/999.'),
      ],
      expectedOutcome: 'answer',
    });

    const toolMsgB = (await Conversation.findById(conversationB._id)).messages.find((m) => m.role === 'tool' && m.name === 'search_products');
    expect(JSON.parse(toolMsgB.content).matches[0].price).toBe(999);

    await Lead.deleteMany({ business: negocioB._id });
    await Product.deleteMany({ business: negocioB._id });
    await Business.deleteMany({ _id: negocioB._id });
  });

  test('Escenario 8 — tool no autorizada/inexistente: el modelo "pide" una tool que no existe, el runtime la rechaza sin romper el turno', async () => {
    const conversation = await crearConversacion('Hacé algo raro');

    await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'borrar_toda_la_base_de_datos', {})]),
        completionFinal('No puedo hacer eso, pero puedo ayudarte con otra cosa.'),
      ],
      expectedOutcome: 'answer',
      expectedTools: ['borrar_toda_la_base_de_datos'],
    });

    const guardada = await Conversation.findById(conversation._id);
    const toolMsg = guardada.messages.find((m) => m.role === 'tool' && m.name === 'borrar_toda_la_base_de_datos');
    expect(JSON.parse(toolMsg.content)).toEqual({ success: false, error: 'Tool desconocida: borrar_toda_la_base_de_datos' });
  });

  test('Escenario 9 — tool falla: check_stock con un productId inválido no inventa un stock, ni tumba el turno', async () => {
    const conversation = await crearConversacion('¿Tienen stock del producto X?');

    await ejecutarEscenario({
      conversation,
      completions: [
        completionConToolCalls([toolCallMock('call_1', 'check_stock', { productId: 'id-invalido-no-un-objectid' })]),
        completionFinal('No pude confirmar el stock ahora mismo, dejame verificarlo.'),
      ],
      expectedOutcome: 'answer',
      expectedTools: ['check_stock'],
    });

    const guardada = await Conversation.findById(conversation._id);
    const toolMsg = guardada.messages.find((m) => m.role === 'tool' && m.name === 'check_stock');
    expect(JSON.parse(toolMsg.content).success).toBe(false);
  });

  test('Escenario 10 — conversación de venta normal sin necesidad de tool: texto libre, sin tools, outcome:"answer"', async () => {
    const conversation = await crearConversacion('Hola, ¿cómo estás?');

    const resultado = await ejecutarEscenario({
      conversation,
      completions: [completionFinal('¡Hola! Muy bien, ¿en qué te puedo ayudar hoy?')],
      expectedOutcome: 'answer',
      expectedTools: [],
    });

    expect(resultado.knowledgeSources).toEqual([]);
    expect(resultado.responseText).toBe('¡Hola! Muy bien, ¿en qué te puedo ayudar hoy?');
  });
});
