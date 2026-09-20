// Test real (Jest, Mongo real) de ai.service.js#generateReply() — CREA
// SALES AI™ C.2, Etapa 8/11 (interoperabilidad con Product Intelligence).
// Mismo criterio exacto que ai.service.generateReply.productIntelligence.test.js
// y ai.service.generateReply.businessKnowledgeHandoff.test.js: secuencia de
// respuestas mockeadas de OpenAI, tool calls REALES contra Mongo.
//
// Cubre TC-11 (documento §23): "¿Cuánto cuesta X y tiene garantía?" — debe
// combinar Product Intelligence (search_products/get_price) y Policies
// (search_business_knowledge) SIN confundir fuentes, en el mismo turno.
//
// Sin código de producción nuevo — tal como anticipó el plan de la Etapa 8
// (docs/implementation/c2-policies-faq-current-state.md, sección 8): el
// loop multi-ronda de generateReply() ya soporta tool_calls de distintos
// dominios en paralelo o en rondas separadas desde antes de C.2 (Caso A de
// Product Intelligence ya combina search_products + check_stock + get_price
// en el mismo turno) — acá se verifica que un producto identificado por
// search_products (conversation.activeProduct) fluye correctamente hacia
// search_business_knowledge SIN que el modelo tenga que repetir el
// productId a mano.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const Policy = require('../business-knowledge/policy.model');
const Conversation = require('./conversation.model');

// Bloque 3 (§53, 20/sep/2026) — mismo motivo que
// ai.service.generateReply.businessKnowledgeHandoff.test.js.
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_mixed_product_knowledge';

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

describe('ai.service#generateReply() — CREA SALES AI™ C.2 (interoperabilidad con Product Intelligence, TC-11)', () => {
  let business;
  let lead;
  let conversation;
  let createSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
    await Policy.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const ultimoMensajeTool = async (nombreTool) => {
    const guardada = await Conversation.findById(conversation._id);
    const msgs = guardada.messages.filter((m) => m.role === 'tool' && m.name === nombreTool);
    return JSON.parse(msgs[msgs.length - 1].content);
  };

  test('TC-11 — precio (Product Intelligence) + garantía (Policy específica) en el mismo turno, sin confundir fuentes', async () => {
    const producto = await Product.create({
      business: business._id,
      sku: 'TQ-MOR-100',
      name: 'Harina de Moringa Te Quiero',
      keywords: ['moringa'],
      price: 50,
      currency: 'PEN',
      physicalStock: 43,
    });

    await Policy.create({
      business: business._id,
      code: 'WARRANTY-MOR',
      title: 'Garantía Harina de Moringa',
      category: 'warranty',
      policyType: 'rule',
      statement: 'La Harina de Moringa tiene 1 año de garantía del fabricante contra defectos.',
      customerFacingText: 'Este producto tiene 1 año de garantía.',
      status: 'active',
      scope: { appliesToAll: false, productIds: [producto._id] },
    });

    conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: '¿Cuánto cuesta la moringa y tiene garantía?' }],
    });

    createSpy
      // Ronda 1: identifica el producto (Product Intelligence).
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]))
      // Ronda 2: precio real + garantía — SIN pasar productIds a
      // search_business_knowledge, a propósito: debe resolverse solo con
      // conversation.activeProduct (documento §21, reusado tal cual en la
      // Etapa 6, sin memoria nueva).
      .mockResolvedValueOnce(completionConToolCalls([
        toolCallMock('call_2', 'get_price', { productId: producto._id.toString() }),
        toolCallMock('call_3', 'search_business_knowledge', { query: 'garantía' }),
      ]))
      .mockResolvedValueOnce(completionFinal('La Harina de Moringa cuesta S/50 y tiene 1 año de garantía del fabricante.'));

    const resultado = await aiService.generateReply(conversation._id, business, lead);

    expect(resultado.reply).toBe('La Harina de Moringa cuesta S/50 y tiene 1 año de garantía del fabricante.');
    expect(createSpy).toHaveBeenCalledTimes(3);

    // Fuente 1 — Product Intelligence: el precio viene de get_price, real.
    const precio = await ultimoMensajeTool('get_price');
    expect(precio).toEqual({ success: true, productId: expect.any(String), price: 50, currency: 'PEN', priceAvailable: true });

    // Fuente 2 — Business Brain: la garantía viene de search_business_knowledge,
    // y encontró la Policy ESPECÍFICA de este producto gracias a
    // conversation.activeProduct (seteado por search_products en la ronda 1) —
    // sin que el modelo mockeado haya pasado productIds a mano.
    const garantia = await ultimoMensajeTool('search_business_knowledge');
    expect(garantia.policies).toHaveLength(1);
    expect(garantia.policies[0]).toMatchObject({ code: 'WARRANTY-MOR', category: 'warranty' });

    // Nunca se confunden los shapes entre las 2 fuentes — cada mensaje `tool`
    // trae solo los campos de su propio dominio.
    expect(precio).not.toHaveProperty('policies');
    expect(garantia).not.toHaveProperty('price');

    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.activeProduct.productId.toString()).toBe(producto._id.toString());
  });

  test('TC-11 (variante) — garantía general (Policy appliesToAll) también aplica sin necesitar el producto identificado', async () => {
    const producto = await Product.create({ business: business._id, sku: 'A', name: 'Producto A', keywords: ['producto a'], price: 30, currency: 'PEN' });

    await Policy.create({
      business: business._id,
      code: 'WARRANTY-GENERAL',
      title: 'Garantía general',
      category: 'warranty',
      policyType: 'rule',
      statement: 'Todos los productos de este negocio tienen 6 meses de garantía.',
      status: 'active',
      scope: { appliesToAll: true },
    });

    conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: '¿Cuánto cuesta el producto A y tiene garantía?' }],
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'producto a' })]))
      .mockResolvedValueOnce(completionConToolCalls([
        toolCallMock('call_2', 'get_price', { productId: producto._id.toString() }),
        toolCallMock('call_3', 'search_business_knowledge', { query: 'garantía' }),
      ]))
      .mockResolvedValueOnce(completionFinal('El Producto A cuesta S/30 y tiene 6 meses de garantía.'));

    const resultado = await aiService.generateReply(conversation._id, business, lead);

    expect(resultado.reply).toBe('El Producto A cuesta S/30 y tiene 6 meses de garantía.');

    const garantia = await ultimoMensajeTool('search_business_knowledge');
    expect(garantia.policies.map((p) => p.code)).toEqual(['WARRANTY-GENERAL']);
  });
});
