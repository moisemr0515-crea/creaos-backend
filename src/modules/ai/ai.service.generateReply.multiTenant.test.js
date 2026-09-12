// Test real (Jest, Mongo real) de ai.service.js#generateReply() — CREA
// Product Intelligence™ V1.0, Etapa 9/10 (pruebas de integración
// multi-tenant end-to-end). Cierra un hueco real de cobertura: los tests
// existentes prueban aislamiento multi-tenant en capas AISLADAS
// (product.service.test.js a nivel service, ai/tools/index.test.js a nivel
// executeToolCall() directo) — pero ninguno corre el LOOP COMPLETO de
// generateReply() (search_products → check_stock → get_price encadenados,
// vía OpenAI mockeado) para 2 negocios distintos en el mismo test, que es
// exactamente el escenario de la sección 34 del documento maestro: mismo
// SKU, precio y stock distintos, cada negocio debe ver solo el suyo.
//
// También cubre un eje de aislamiento DISTINTO al de tenant: 2
// conversaciones del MISMO negocio nunca deben compartir
// `conversation.activeProduct` entre sí — cada Conversation es su propio
// documento, pero no había ningún test que lo probara corriendo
// generateReply() dos veces con conversaciones distintas.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_multi_tenant';

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

/** Arma una Conversation con Business/Lead reales, lista para generateReply(). */
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

describe('ai.service#generateReply() — aislamiento multi-tenant end-to-end (documento §34)', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
  });

  test('escenario exacto de la sección 34: mismo SKU, precio y stock distintos en 2 negocios — cada conversación responde solo con lo suyo', async () => {
    const negocioA = await Business.create({ name: 'Negocio A', currency: 'PEN' });
    const negocioB = await Business.create({ name: 'Negocio B', currency: 'PEN' });

    const productoA = await Product.create({ business: negocioA._id, sku: 'MOR-001', name: 'Moringa', price: 50, physicalStock: 10 });
    const productoB = await Product.create({ business: negocioB._id, sku: 'MOR-001', name: 'Moringa', price: 65, physicalStock: 100 });

    const { lead: leadA, conversation: conversationA } = await crearConversacion(negocioA, '¿Tienen moringa?');
    const { lead: leadB, conversation: conversationB } = await crearConversacion(negocioB, '¿Tienen moringa?');

    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    // --- Turno completo para el Negocio A ---
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_a1', 'search_products', { query: 'moringa' })]))
      .mockResolvedValueOnce(completionConToolCalls([
        toolCallMock('call_a2', 'check_stock', { productId: productoA._id.toString() }),
        toolCallMock('call_a3', 'get_price', { productId: productoA._id.toString() }),
      ]))
      .mockResolvedValueOnce(completionFinal('Sí, tenemos moringa a S/50, con stock disponible.'));

    const resultadoA = await aiService.generateReply(conversationA._id, negocioA, leadA);
    expect(resultadoA.reply).toBe('Sí, tenemos moringa a S/50, con stock disponible.');

    const stockA = await ultimoMensajeTool(conversationA._id, 'check_stock');
    const precioA = await ultimoMensajeTool(conversationA._id, 'get_price');
    expect(stockA).toMatchObject({ physicalStock: 10, availableStock: 10 });
    expect(precioA).toMatchObject({ price: 50 });

    // --- Turno completo para el Negocio B, INMEDIATAMENTE después (mismo
    // proceso, mismo módulo aiService ya "usado") — si hubiera algún estado
    // compartido/cacheado por error entre llamadas, acá se notaría. ---
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_b1', 'search_products', { query: 'moringa' })]))
      .mockResolvedValueOnce(completionConToolCalls([
        toolCallMock('call_b2', 'check_stock', { productId: productoB._id.toString() }),
        toolCallMock('call_b3', 'get_price', { productId: productoB._id.toString() }),
      ]))
      .mockResolvedValueOnce(completionFinal('Sí, tenemos moringa a S/65, con stock disponible.'));

    const resultadoB = await aiService.generateReply(conversationB._id, negocioB, leadB);
    expect(resultadoB.reply).toBe('Sí, tenemos moringa a S/65, con stock disponible.');

    const stockB = await ultimoMensajeTool(conversationB._id, 'check_stock');
    const precioB = await ultimoMensajeTool(conversationB._id, 'get_price');
    expect(stockB).toMatchObject({ physicalStock: 100, availableStock: 100 });
    expect(precioB).toMatchObject({ price: 65 });

    // Verificación cruzada explícita: ninguno de los 2 números se filtró al otro.
    expect(precioA.price).not.toBe(precioB.price);
    expect(stockA.physicalStock).not.toBe(stockB.physicalStock);

    // El activeProduct de cada conversación apunta a SU PROPIO producto, nunca al del otro negocio.
    const conversationAGuardada = await Conversation.findById(conversationA._id);
    const conversationBGuardada = await Conversation.findById(conversationB._id);
    expect(conversationAGuardada.activeProduct.productId.toString()).toBe(productoA._id.toString());
    expect(conversationBGuardada.activeProduct.productId.toString()).toBe(productoB._id.toString());
  });

  test('aislamiento entre 2 conversaciones del MISMO negocio: el activeProduct de una nunca resuelve en la otra', async () => {
    const business = await Business.create({ name: 'Negocio de prueba' });
    const producto = await Product.create({ business: business._id, sku: 'ACE-001', name: 'Aceite de coco', price: 30, physicalStock: 5 });

    const { lead: lead1, conversation: conversation1 } = await crearConversacion(business, '¿Tienen aceite de coco?');
    const { lead: lead2, conversation: conversation2 } = await crearConversacion(business, '¿Y el stock?');

    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    // Conversation 1 busca y encuentra el producto — le queda activeProduct seteado.
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'aceite de coco' })]))
      .mockResolvedValueOnce(completionFinal('Sí, tenemos aceite de coco.'));
    await aiService.generateReply(conversation1._id, business, lead1);

    const conversation1Guardada = await Conversation.findById(conversation1._id);
    expect(conversation1Guardada.activeProduct.productId.toString()).toBe(producto._id.toString());

    // Conversation 2 (OTRO lead, nunca buscó nada) pregunta por el stock SIN
    // productId — si activeProduct se compartiera entre conversaciones por
    // error, esto resolvería el producto de la conversation 1. Debe fallar
    // (fail-soft) en cambio.
    createSpy.mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_2', 'check_stock', {})]));
    createSpy.mockResolvedValueOnce(completionFinal('No tengo un producto identificado en esta conversación todavía.'));
    await aiService.generateReply(conversation2._id, business, lead2);

    const resultadoCheckStock = await ultimoMensajeTool(conversation2._id, 'check_stock');
    expect(resultadoCheckStock.success).toBe(false);

    const conversation2Guardada = await Conversation.findById(conversation2._id);
    expect(conversation2Guardada.activeProduct).toBeFalsy();
  });
});
