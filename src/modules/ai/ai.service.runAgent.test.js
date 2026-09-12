// Test real (Jest, Mongo real) de ai.service.js#runAgent() y de los campos
// nuevos que generateReply() ahora también devuelve (toolsUsed/
// knowledgeSources) — CREA SALES AI™ C.3, Etapa C3.1 (Runtime Contract).
// Mismo criterio que ai.service.generateReply.productIntelligence.test.js:
// secuencia de respuestas mockeadas de OpenAI, tool calls REALES contra
// Mongo/servicios ya existentes — acá el foco es el SHAPE nuevo del
// resultado, no volver a probar el comportamiento de cada tool (eso ya
// está cubierto en sus propios archivos).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const Policy = require('../business-knowledge/policy.model');
const FAQ = require('../business-knowledge/faq.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_run_agent';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

describe('ai.service#runAgent() — Runtime Contract (C.3, Etapa C3.1)', () => {
  let business;
  let lead;
  let conversation;
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
    business = await Business.create({ name: 'Negocio de prueba' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const crearConversacion = async (mensajeInicial) =>
    Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: mensajeInicial }],
    });

  describe('sin tool calls (camino más común)', () => {
    test('outcome:"answer", responseText = el reply real, toolsUsed/knowledgeSources vacíos, correlationId autogenerado (uuid v4)', async () => {
      conversation = await crearConversacion('Hola, ¿cómo estás?');
      createSpy.mockResolvedValueOnce(completionFinal('¡Hola! ¿En qué te puedo ayudar?'));

      const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

      expect(resultado).toEqual({
        outcome: 'answer',
        responseText: '¡Hola! ¿En qué te puedo ayudar?',
        toolsUsed: [],
        knowledgeSources: [],
        correlationId: expect.any(String),
        // tokensUsed — agregado en la Etapa C3.1b (DefaultAgentRuntime lo
        // necesitaba, ver ai.service.js#runAgent()) — no es del contrato
        // literal de la spec, se verifica igual acá para no dejar un campo
        // sin cubrir en el test que define el shape completo.
        tokensUsed: expect.any(Number),
      });
      expect(resultado.correlationId).toMatch(UUID_V4_REGEX);
    });

    test('respeta un correlationId ya provisto en vez de generar uno nuevo', async () => {
      conversation = await crearConversacion('Hola');
      createSpy.mockResolvedValueOnce(completionFinal('¡Hola!'));

      const resultado = await aiService.runAgent({
        conversationId: conversation._id,
        business,
        lead,
        correlationId: 'run-fijo-de-prueba-123',
      });

      expect(resultado.correlationId).toBe('run-fijo-de-prueba-123');
    });
  });

  describe('toolsUsed / knowledgeSources — Product Intelligence', () => {
    test('search_products/check_stock/get_price colapsan a knowledgeSources:["product_catalog"]', async () => {
      const producto = await Product.create({
        business: business._id,
        sku: 'MOR-001',
        name: 'Moringa',
        keywords: ['moringa'],
        price: 50,
        physicalStock: 10,
      });
      conversation = await crearConversacion('¿Tienen moringa?');

      createSpy
        .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]))
        .mockResolvedValueOnce(completionConToolCalls([
          toolCallMock('call_2', 'check_stock', { productId: producto._id.toString() }),
          toolCallMock('call_3', 'get_price', { productId: producto._id.toString() }),
        ]))
        .mockResolvedValueOnce(completionFinal('Sí, tenemos moringa a $50, con stock.'));

      const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

      expect(resultado.outcome).toBe('answer');
      expect(resultado.toolsUsed.sort()).toEqual(['check_stock', 'get_price', 'search_products'].sort());
      expect(resultado.knowledgeSources).toEqual(['product_catalog']); // un Set — sin duplicar pese a 3 tools distintas
    });
  });

  describe('toolsUsed / knowledgeSources — Business Knowledge', () => {
    test('search_business_knowledge con Policy real aporta "policy:<code>"', async () => {
      await Policy.create({
        business: business._id,
        code: 'RETURNS-001',
        title: 'Devoluciones',
        category: 'returns',
        policyType: 'rule',
        statement: 'Se aceptan devoluciones dentro de 7 días.',
        status: 'active',
      });
      conversation = await crearConversacion('¿Cuál es la política de devoluciones?');

      createSpy
        .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'devoluciones' })]))
        .mockResolvedValueOnce(completionFinal('Aceptamos devoluciones dentro de 7 días.'));

      const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

      expect(resultado.toolsUsed).toEqual(['search_business_knowledge']);
      expect(resultado.knowledgeSources).toEqual(['policy:RETURNS-001']);
    });

    test('search_business_knowledge con FAQ real aporta "faq" (sin id individual — el tool no expone uno)', async () => {
      await FAQ.create({
        business: business._id,
        question: '¿Aceptan Yape?',
        answer: 'Sí, aceptamos Yape.',
        category: 'payments',
        status: 'active',
      });
      conversation = await crearConversacion('¿Aceptan Yape?');

      createSpy
        .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'yape' })]))
        .mockResolvedValueOnce(completionFinal('Sí, aceptamos Yape.'));

      const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

      expect(resultado.knowledgeSources).toEqual(['faq']);
    });

    test('sin resultados: toolsUsed sí registra la tool pedida, knowledgeSources queda vacío', async () => {
      conversation = await crearConversacion('¿Tienen garantía de por vida?');

      createSpy
        .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'garantía de por vida' })]))
        .mockResolvedValueOnce(completionFinal('No tengo esa información confirmada ahora mismo.'));

      const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

      expect(resultado.toolsUsed).toEqual(['search_business_knowledge']);
      expect(resultado.knowledgeSources).toEqual([]);
    });
  });

  describe('outcome:"handoff"', () => {
    test('escalate_to_human ejecutada → outcome:"handoff", incluida en toolsUsed', async () => {
      conversation = await crearConversacion('Quiero hablar con una persona');

      createSpy
        .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'escalate_to_human', { reason: 'El lead pidió hablar con un humano.' })]))
        .mockResolvedValueOnce(completionFinal('Te voy a derivar con un agente humano.'));

      const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

      expect(resultado.outcome).toBe('handoff');
      expect(resultado.toolsUsed).toEqual(['escalate_to_human']);

      const guardada = await Conversation.findById(conversation._id);
      expect(guardada.status).toBe('escalated');
    });
  });

  describe('propagación de errores — sin cambiar el comportamiento existente', () => {
    test('si generateReply() lanza (loop de tool calls agotado), runAgent() propaga la MISMA excepción, no la convierte en un outcome:"error"', async () => {
      conversation = await crearConversacion('Pregunta cualquiera');

      // El modelo mockeado pide tools indefinidamente, sin converger nunca a
      // una respuesta de texto final — agota MAX_TOOL_ITERATIONS (5).
      for (let i = 0; i < 5; i += 1) {
        createSpy.mockResolvedValueOnce(completionConToolCalls([toolCallMock(`call_${i}`, 'escalate_to_human', { reason: 'x' })]));
      }

      await expect(aiService.runAgent({ conversationId: conversation._id, business, lead })).rejects.toMatchObject({
        statusCode: 500,
        message: expect.stringContaining('demasiadas tool calls encadenadas'),
      });
    });
  });

  describe('generateReply() — mismos campos nuevos, disponibles también fuera de runAgent()', () => {
    test('generateReply() por sí sola ya devuelve toolsUsed/knowledgeSources (runAgent() solo los reexpone)', async () => {
      conversation = await crearConversacion('Hola');
      createSpy.mockResolvedValueOnce(completionFinal('¡Hola!'));

      const resultado = await aiService.generateReply(conversation._id, business, lead);

      expect(resultado).toMatchObject({ reply: '¡Hola!', toolsUsed: [], knowledgeSources: [] });
    });
  });
});
