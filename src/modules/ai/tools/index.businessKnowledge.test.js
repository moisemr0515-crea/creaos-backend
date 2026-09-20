// Test real (Jest, Mongo real) de la tool search_business_knowledge en
// ai/tools/index.js — CREA SALES AI™ C.2, Etapa 6/11. Mismo patrón que
// index.test.js (search_products/check_stock/get_price): se invoca vía
// executeToolCall(), el mismo punto de entrada real que usa generateReply(),
// para probar también el parseo de argumentos y el fail-soft genérico.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Product = require('../../products/product.model');
const WhatsAppChannel = require('../../channels/whatsappChannel.model');
const Policy = require('../../business-knowledge/policy.model');
const FAQ = require('../../business-knowledge/faq.model');
const Conversation = require('../conversation.model');

// Bloque 3 (§45-51/§53, 20/sep/2026) — resolverConocimiento() ahora pide
// embeddings reales (query + chunks del PDF/semántica de Policy/FAQ). Se
// mockea acá para no pegarle a OpenAI en cada test — el retrieval
// semántico en sí (buscarSemantico(), buscarChunksDocumento()) ya tiene su
// propio test dedicado (knowledgeRetrieval.service.test.js) con un
// $vectorSearch real no disponible en Mongo local de todas formas (se
// prueba con mocks ahí). Este archivo se queda enfocado en su contrato
// real: qué le llega al modelo a través de la tool.
jest.mock('../../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const { executeToolCall } = require('./index');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_business_knowledge';

const toolCall = (name, args) => ({
  id: 'call_test_1',
  function: { name, arguments: JSON.stringify(args) },
});

describe('ai/tools/index — search_business_knowledge (CREA SALES AI™ C.2)', () => {
  let business;
  let conversation;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    conversation = new Conversation({ business: business._id, lead: new mongoose.Types.ObjectId(), channel: 'whatsapp' });
  });

  const crearPolicy = (overrides = {}) =>
    Policy.create({
      business: business._id,
      code: overrides.code || `POL-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      title: 'Policy de prueba',
      category: 'returns',
      policyType: 'rule',
      statement: 'Statement interno de prueba',
      status: 'active',
      scope: { appliesToAll: true },
      ...overrides,
    });

  test('sin "query": success:false, no lanza', async () => {
    const result = await executeToolCall(toolCall('search_business_knowledge', {}), { conversation, business, lead: null });
    expect(result).toEqual({ success: false, error: expect.stringContaining('query') });
  });

  test('devuelve policies/faqs recortadas — nunca expone _id/business/source/version al modelo', async () => {
    await crearPolicy({ statement: 'Aceptamos devoluciones dentro de 7 días' });

    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'devolución' }), { conversation, business, lead: null });

    expect(result.success).toBe(true);
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toEqual({
      code: expect.any(String),
      category: 'returns',
      statement: 'Aceptamos devoluciones dentro de 7 días',
      customerFacingText: null,
      responseMode: 'answer',
      handoffReason: null,
    });
    expect(result.policies[0]._id).toBeUndefined();
    expect(result.policies[0].business).toBeUndefined();
    expect(result.policies[0].source).toBeUndefined();
    expect(result.policies[0].version).toBeUndefined();
  });

  test('NUNCA acepta un tenant/businessId desde args — solo usa context.business', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    await Policy.create({
      business: otroBusiness._id,
      code: 'AJENA',
      title: 'Policy ajena',
      category: 'returns',
      policyType: 'rule',
      statement: 'Statement de otro negocio',
      status: 'active',
    });

    const result = await executeToolCall(
      toolCall('search_business_knowledge', { query: 'statement', businessId: otroBusiness._id.toString() }),
      { conversation, business, lead: null }
    );

    expect(result.success).toBe(true);
    expect(result.policies).toHaveLength(0); // ninguna del negocio ajeno
  });

  test('usa conversation.activeProduct como fallback de productIds (documento §21, sin memoria nueva)', async () => {
    const producto = await Product.create({ business: business._id, sku: 'X', name: 'Producto X' });
    conversation.activeProduct = { productId: producto._id, name: 'Producto X', lastSearchQuery: 'x', updatedAt: new Date() };

    await crearPolicy({ code: 'ESPECIFICA', statement: 'Producto X no admite cambios', scope: { appliesToAll: false, productIds: [producto._id] } });

    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'cambios' }), { conversation, business, lead: null });

    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].code).toBe('ESPECIFICA');
  });

  test('args.productIds explícito tiene prioridad sobre activeProduct', async () => {
    const productoActivo = await Product.create({ business: business._id, sku: 'ACTIVO', name: 'Producto activo' });
    const productoExplicito = await Product.create({ business: business._id, sku: 'EXPLICITO', name: 'Producto explícito' });
    conversation.activeProduct = { productId: productoActivo._id, name: 'Producto activo', lastSearchQuery: 'x', updatedAt: new Date() };

    await crearPolicy({ code: 'DE-EXPLICITO', statement: 'Regla del producto explícito', scope: { appliesToAll: false, productIds: [productoExplicito._id] } });

    const result = await executeToolCall(
      toolCall('search_business_knowledge', { query: 'regla', productIds: [productoExplicito._id.toString()] }),
      { conversation, business, lead: null }
    );

    expect(result.policies.map((p) => p.code)).toEqual(['DE-EXPLICITO']);
  });

  test('usa conversation.whatsappChannel como channelId de contexto, nunca del modelo', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      phoneNumber: '+51900000000',
      phoneNumberId: 'phone-id-1',
      connectionType: 'PLATFORM',
    });
    conversation.whatsappChannel = canal._id;

    await crearPolicy({ code: 'DE-CANAL', statement: 'Regla exclusiva de este canal', scope: { appliesToAll: false, channelIds: [canal._id] } });

    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'regla' }), { conversation, business, lead: null });

    expect(result.policies.map((p) => p.code)).toEqual(['DE-CANAL']);
  });

  test('propaga needsClarification:true (TC-08) sin elegir una policy al azar', async () => {
    const producto = await Product.create({ business: business._id, sku: 'X', name: 'Producto X' });
    await crearPolicy({ code: 'GENERAL', category: 'returns', statement: 'Cambios hasta 7 días', scope: { appliesToAll: true } });
    await crearPolicy({ code: 'VARIANTE', category: 'returns', statement: 'Producto X no admite cambios', scope: { appliesToAll: false, productIds: [producto._id] } });

    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'cambios' }), { conversation, business, lead: null });

    expect(result.needsClarification).toBe(true);
  });

  test('propaga conflictDetected:true (TC-10) — la policy sigue siendo la primera del resultado', async () => {
    await crearPolicy({ code: 'RETURNS-7D', category: 'returns', statement: 'Las devoluciones se aceptan dentro de 7 días' });
    await FAQ.create({
      business: business._id,
      question: '¿Cuál es la política de devolución?',
      answer: 'Tenés 15 días para hacer una devolución',
      category: 'returns',
      status: 'active',
    });

    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'devolución' }), { conversation, business, lead: null });

    expect(result.conflictDetected).toBe(true);
    expect(result.policies[0].code).toBe('RETURNS-7D');
  });

  test('sin resultados: success:true con arrays vacíos, sin needsClarification ni conflictDetected forzados', async () => {
    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'algo que no existe' }), { conversation, business, lead: null });

    expect(result).toEqual({
      success: true,
      policies: [],
      faqs: [],
      documentChunks: [],
      conflictDetected: false,
      needsClarification: false,
    });
  });

  test('faqs recortadas — solo question/answer/category', async () => {
    await FAQ.create({
      business: business._id,
      question: '¿Aceptan Yape?',
      answer: 'Sí, aceptamos Yape y Plin.',
      category: 'payments',
      status: 'active',
    });

    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'yape' }), { conversation, business, lead: null });

    expect(result.faqs).toEqual([{ question: '¿Aceptan Yape?', answer: 'Sí, aceptamos Yape y Plin.', category: 'payments' }]);
  });

  test('argumentos con JSON malformado: fail-soft genérico de executeToolCall(), no lanza', async () => {
    const malformado = { id: 'call_x', function: { name: 'search_business_knowledge', arguments: '{invalido' } };
    const result = await executeToolCall(malformado, { conversation, business, lead: null });
    expect(result.success).toBe(false);
  });
});
