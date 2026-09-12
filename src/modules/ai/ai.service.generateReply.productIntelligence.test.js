// Test real (Jest, Mongo real) de ai.service.js#generateReply() — CREA
// Product Intelligence™ V1.0, Etapa 7/10. Cubre los 4 casos de respuesta
// esperada del documento maestro (§23: A. existe con stock, B. existe sin
// stock, C. no encontrado, D. ambigüedad) simulando la conversación
// COMPLETA a través del loop real de tool-calling de generateReply() —no
// solo llamando a los executors en aislado (eso ya está cubierto en
// ai/tools/index.test.js).
//
// openai.chat.completions.create() se mockea con una secuencia de
// respuestas pre-escritas (una por cada "vuelta" del loop) — eso es lo
// único que se simula. Lo que estas pruebas verifican de verdad es que,
// dada esa secuencia, generateReply()/executeToolCall() ejecutan las tool
// calls REALES contra product.service.js/Mongo, en el orden correcto, y que
// los datos que terminan en cada mensaje role:'tool' (lo único que el
// modelo real vería para redactar su respuesta) son los datos reales del
// catálogo — nunca inventados. No se prueba (ni se puede probar sin pegarle
// a la API real) si un modelo de verdad decidiría usar las tools o qué
// texto exacto redactaría; eso es responsabilidad de OpenAI, no de este
// código.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_product_intelligence';

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

describe('ai.service#generateReply() — CREA Product Intelligence™ (documento §23)', () => {
  let business;
  let lead;
  let conversation;
  let createSpy;

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
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
    conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: '¿Tienen moringa?' }],
    });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const correrTurno = async () => aiService.generateReply(conversation._id, business, lead);

  const ultimoMensajeTool = async (nombreTool) => {
    const guardada = await Conversation.findById(conversation._id);
    const msgs = guardada.messages.filter((m) => m.role === 'tool' && m.name === nombreTool);
    return JSON.parse(msgs[msgs.length - 1].content);
  };

  test('Caso A — existe con stock: search_products → check_stock → get_price, con datos reales del catálogo', async () => {
    const producto = await Product.create({
      business: business._id,
      sku: 'TQ-MOR-100',
      name: 'Harina de Moringa Te Quiero',
      keywords: ['moringa', 'capsulas'],
      price: 50,
      currency: 'PEN',
      physicalStock: 43,
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]))
      .mockResolvedValueOnce(completionConToolCalls([
        toolCallMock('call_2', 'check_stock', { productId: producto._id.toString() }),
        toolCallMock('call_3', 'get_price', { productId: producto._id.toString() }),
      ]))
      .mockResolvedValueOnce(completionFinal('Sí, tenemos Harina de Moringa a S/50, con stock disponible.'));

    const resultado = await correrTurno();

    expect(resultado.reply).toBe('Sí, tenemos Harina de Moringa a S/50, con stock disponible.');
    expect(createSpy).toHaveBeenCalledTimes(3);

    const stock = await ultimoMensajeTool('check_stock');
    expect(stock).toMatchObject({ success: true, trackInventory: true, availableStock: 43, inStock: true });

    const precio = await ultimoMensajeTool('get_price');
    expect(precio).toEqual({ success: true, productId: expect.any(String), price: 50, currency: 'PEN', priceAvailable: true });

    // El contexto conversacional (§21) quedó guardado — un follow-up
    // "¿cuánto cuesta?" en el próximo turno podría resolverse sin repetir el nombre.
    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.activeProduct.productId.toString()).toBe(producto._id.toString());
  });

  test('Caso B — existe SIN stock: check_stock refleja inStock:false real, sin inventar fecha de reposición', async () => {
    const producto = await Product.create({
      business: business._id,
      sku: 'TQ-MOR-100',
      name: 'Harina de Moringa Te Quiero',
      keywords: ['moringa'],
      price: 50,
      physicalStock: 0,
    });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]))
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_2', 'check_stock', { productId: producto._id.toString() })]))
      .mockResolvedValueOnce(completionFinal('Por ahora no tenemos stock disponible de ese producto.'));

    const resultado = await correrTurno();

    expect(resultado.reply).toBe('Por ahora no tenemos stock disponible de ese producto.');

    const stock = await ultimoMensajeTool('check_stock');
    expect(stock).toMatchObject({ success: true, inStock: false, availableStock: 0 });
    // La tool nunca devuelve (ni inventa) una fecha de reposición — no existe
    // ningún campo así en el shape real de consultarStock().
    expect(stock).not.toHaveProperty('restockDate');
    expect(stock).not.toHaveProperty('reposicion');
  });

  test('Caso C — producto no encontrado: search_products devuelve matches:[], no se setea activeProduct', async () => {
    // Catálogo con productos, pero NINGUNO relacionado a la búsqueda.
    await Product.create({ business: business._id, sku: 'ACE-001', name: 'Aceite de coco', keywords: ['aceite'] });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'zapatillas' })]))
      .mockResolvedValueOnce(completionFinal('No encontré ese producto en nuestro catálogo. ¿Te ayudo con algo más?'));

    const resultado = await correrTurno();

    expect(resultado.reply).toBe('No encontré ese producto en nuestro catálogo. ¿Te ayudo con algo más?');

    const busqueda = await ultimoMensajeTool('search_products');
    expect(busqueda).toEqual({ success: true, matches: [] });

    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.activeProduct).toBeFalsy();
  });

  test('Caso D — ambigüedad: search_products devuelve varias coincidencias, sin afirmar precio/stock de ninguna todavía', async () => {
    await Product.create({ business: business._id, sku: 'MOR-CAP', name: 'Moringa en cápsulas', keywords: ['moringa'], price: 50 });
    await Product.create({ business: business._id, sku: 'MOR-POL', name: 'Moringa en polvo', keywords: ['moringa'], price: 35 });

    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'search_products', { query: 'moringa' })]))
      .mockResolvedValueOnce(completionFinal('Tenemos moringa en cápsulas y en polvo — ¿cuál te interesa?'));

    const resultado = await correrTurno();

    expect(resultado.reply).toBe('Tenemos moringa en cápsulas y en polvo — ¿cuál te interesa?');

    const busqueda = await ultimoMensajeTool('search_products');
    expect(busqueda.matches).toHaveLength(2);
    // El resultado ambiguo nunca afirma precio/stock por su cuenta — search_products
    // no devuelve availableStock/price "confirmados", solo lo que el catálogo tiene
    // cargado; check_stock/get_price (que este turno no llegó a llamar, a
    // propósito, porque el modelo mockeado optó por preguntar primero) son
    // las únicas fuentes de verdad para afirmar disponibilidad real.
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
