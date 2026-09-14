// Test real (Jest, Mongo real) de inbound.worker.js#processInboundJob() —
// CREA SALES AI™ C.3, Etapa C3.1b. Reproduce el escenario EXACTO que
// encontró la auditoría (docs/implementation/c3-runtime-current-state.md
// §3.3): el `businessContext` que este archivo armaba para
// AgentRuntime.process() tenía SOLO 6 campos (name/productDescription/
// targetCustomer/pdfSummary/pdfExtractedText/aiInstructions) — sin
// `business._id` (que TODAS las tools de Product Intelligence/Business
// Knowledge necesitan para escopar por tenant) ni `business.aiPersonality`
// (que buildSystemPrompt() usa). Verificado de forma empírica antes de
// escribir este archivo: `Product.find({business: undefined, ...})` no
// lanza ni filtra cruzado — devuelve 0 resultados siempre, en silencio.
//
// A diferencia de inbound.worker.test.js (que mockea
// aiService.generateReply directo para no depender del loop real de
// tool-calling), estos tests mockean SOLO openai.chat.completions.create()
// — igual que ai.service.generateReply.*.test.js — para ejercer el camino
// REAL completo: processInboundJob() -> DefaultAgentRuntime.process() ->
// aiService.runAgent() -> generateReply() -> executeToolCall() ->
// product.service.js, con Mongo real. Así, si el gap del businessContext
// volviera (una regresión futura), este test lo detecta de verdad — un
// mock de generateReply() nunca lo haría, porque nunca le pasa
// `business` a ninguna tool real.
jest.mock('../queues/outbound.queue', () => ({
  enqueueOutbound: jest.fn().mockResolvedValue(undefined),
  getOutboundQueue: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Conversation = require('../../ai/conversation.model');
const InboundEvent = require('../inboundEvent.model');
const Pipeline = require('../../pipeline/pipeline.model');
const Product = require('../../products/product.model');
const aiService = require('../../ai/ai.service');
const subscriptionService = require('../../subscriptions/subscription.service');
const { processInboundJob } = require('./inbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_inbound_worker_business_context';
const PHONE = '+51900000002';

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

describe('inbound.worker#processInboundJob() — fix del gap de businessContext (C.3, Etapa C3.1b)', () => {
  let business;
  let createSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await InboundEvent.deleteMany({});
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      planName: 'closer', limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    });
    await InboundEvent.deleteMany({});
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba', aiPersonality: 'formal' });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
    // qualifyLead() corre fire-and-forget después del reply (ver
    // inbound.worker.js#processInboundJob()) — mockeado acá para los 3
    // tests de este archivo, mismo criterio que inbound.worker.test.js:
    // sin esto, dispara una llamada real a OpenAI sin mockear (createSpy
    // solo tiene mocks encolados para el turno principal) después de que
    // el test ya terminó y cerró la conexión a Mongo.
    jest.spyOn(aiService, 'qualifyLead').mockResolvedValue({});
  });

  const crearInboundEvent = (overrides = {}) =>
    InboundEvent.create({
      providerMessageId: `msg-${new mongoose.Types.ObjectId()}`,
      provider: 'gupshup',
      channel: new mongoose.Types.ObjectId(),
      tenantId: business._id,
      from: PHONE,
      text: '¿Tienen moringa?',
      status: 'received',
      ...overrides,
    });

  test('search_products encuentra el producto REAL del negocio — business._id viaja completo hasta la tool a través del Worker', async () => {
    const producto = await Product.create({
      business: business._id,
      sku: 'MOR-001',
      name: 'Moringa',
      keywords: ['moringa'],
      price: 50,
      physicalStock: 10,
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]))
      .mockResolvedValueOnce(completionFinal('Sí, tenemos moringa.'));

    const event = await crearInboundEvent();
    await processInboundJob({ data: { inboundEventId: event._id } });

    const conversation = await Conversation.findOne({ business: business._id });
    const toolMsg = conversation.messages.find((m) => m.role === 'tool' && m.name === 'search_products');
    const resultado = JSON.parse(toolMsg.content);

    // Con el gap presente (businessContext sin _id), esto daba
    // matches:[] SIEMPRE — ver la nota de arriba sobre la verificación
    // empírica de business:undefined en Mongo.
    expect(resultado.success).toBe(true);
    expect(resultado.matches).toHaveLength(1);
    expect(resultado.matches[0].sku).toBe('MOR-001');
  });

  test('search_business_knowledge también funciona a través del Worker — mismo camino, misma corrección', async () => {
    const Policy = require('../../business-knowledge/policy.model');
    await Policy.init();
    await Policy.create({
      business: business._id,
      code: 'WARRANTY-001',
      title: 'Garantía',
      category: 'warranty',
      policyType: 'rule',
      statement: 'Todos los productos tienen 1 año de garantía.',
      status: 'active',
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_business_knowledge', { query: 'garantía' })]))
      .mockResolvedValueOnce(completionFinal('Sí, 1 año de garantía.'));

    const event = await crearInboundEvent({ text: '¿Tienen garantía?' });
    await processInboundJob({ data: { inboundEventId: event._id } });

    const conversation = await Conversation.findOne({ business: business._id });
    const toolMsg = conversation.messages.find((m) => m.role === 'tool' && m.name === 'search_business_knowledge');
    const resultado = JSON.parse(toolMsg.content);

    expect(resultado.policies).toHaveLength(1);
    expect(resultado.policies[0].code).toBe('WARRANTY-001');

    await Policy.deleteMany({});
  });

  test('aiPersonality del negocio SÍ llega al prompt a través del Worker (antes del fix, siempre caía al default "cercano")', async () => {
    // business.aiPersonality:'formal' ya seteado en beforeEach — si el
    // gap estuviera presente, buildSystemPrompt() nunca vería ese campo
    // (businessContext no lo traía) y usaría siempre el bloque de
    // personalidad 'cercano' por default, sin importar qué haya
    // configurado el negocio.
    createSpy.mockImplementationOnce(async (params) => {
      const systemMessage = params.messages.find((m) => m.role === 'system');
      expect(systemMessage.content).toMatch(/tono formal y profesional/i);
      expect(systemMessage.content).not.toMatch(/como si fueras un amigo de confianza/i);
      return completionFinal('Buenas tardes, ¿en qué puedo asistirle?');
    });

    const event = await crearInboundEvent({ text: 'Hola' });
    await processInboundJob({ data: { inboundEventId: event._id } });

    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
