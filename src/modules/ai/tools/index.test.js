// Test real (Jest, Mongo real) de las 3 tools de CREA Product Intelligence™
// V1.0 (Etapa 6/10): search_products/check_stock/get_price en
// ai/tools/index.js. No existía ningún test dedicado de este archivo hasta
// ahora (escalate_to_human/update_lead_stage no tienen cobertura propia,
// fuera de alcance de este PR) — este archivo cubre SOLO las 3 tools nuevas,
// vía executeToolCall() (el mismo punto de entrada real que usa
// generateReply()) para probar también el parseo de argumentos y el
// fail-soft genérico, no solo los executors a mano.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Product = require('../../products/product.model');
const Conversation = require('../conversation.model');
const { executeToolCall } = require('./index');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_products';

const toolCall = (name, args) => ({
  id: 'call_test_1',
  function: { name, arguments: JSON.stringify(args) },
});

describe('ai/tools/index — search_products/check_stock/get_price', () => {
  let business;
  let conversation;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    conversation = new Conversation({ business: business._id, lead: new mongoose.Types.ObjectId(), channel: 'whatsapp' });
  });

  describe('search_products', () => {
    beforeEach(async () => {
      await Product.create({
        business: business._id,
        sku: 'TQ-MOR-100',
        name: 'Harina de Moringa Te Quiero',
        keywords: ['moringa', 'capsulas', 'pastillas'],
        price: 50,
        currency: 'PEN',
        physicalStock: 43,
      });
    });

    test('devuelve matches y NUNCA acepta un tenant/businessId desde args — solo usa context.business', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await Product.create({ business: otroBusiness._id, sku: 'X', name: 'Producto de otro negocio', keywords: ['moringa'] });

      const result = await executeToolCall(
        toolCall('search_products', { query: 'moringa', businessId: otroBusiness._id.toString(), tenantId: otroBusiness._id.toString() }),
        { conversation, business, lead: null }
      );

      expect(result.success).toBe(true);
      expect(result.matches).toHaveLength(1); // solo el del negocio real (context.business), no el de otroBusiness
      expect(result.matches[0].sku).toBe('TQ-MOR-100');
    });

    test('actualiza conversation.activeProduct en memoria (sin llamar a .save())', async () => {
      const saveSpy = jest.spyOn(conversation, 'save');

      await executeToolCall(toolCall('search_products', { query: 'moringa' }), { conversation, business, lead: null });

      expect(conversation.activeProduct.name).toBe('Harina de Moringa Te Quiero');
      expect(conversation.activeProduct.lastSearchQuery).toBe('moringa');
      expect(saveSpy).not.toHaveBeenCalled();
    });

    test('sin resultados: NO borra un activeProduct ya seteado de un turno anterior', async () => {
      const productoPrevio = await Product.create({ business: business._id, sku: 'ACE-001', name: 'Aceite de coco' });
      conversation.activeProduct = { productId: productoPrevio._id, name: 'Aceite de coco', lastSearchQuery: 'aceite', updatedAt: new Date() };

      const result = await executeToolCall(toolCall('search_products', { query: 'algo que no existe' }), { conversation, business, lead: null });

      expect(result.matches).toEqual([]);
      expect(conversation.activeProduct.name).toBe('Aceite de coco'); // intacto
    });

    test('sin "query": success:false, no lanza', async () => {
      const result = await executeToolCall(toolCall('search_products', {}), { conversation, business, lead: null });
      expect(result).toEqual({ success: false, error: expect.stringContaining('query') });
    });
  });

  describe('check_stock', () => {
    test('con productId explícito: refleja el stock real', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', physicalStock: 5, minimumStock: 10 });

      const result = await executeToolCall(toolCall('check_stock', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result).toMatchObject({ success: true, trackInventory: true, physicalStock: 5, availableStock: 5, inStock: true, lowStock: true });
    });

    test('trackInventory:false (servicio) — nunca "agotado", NOT_TRACKED', async () => {
      const producto = await Product.create({ business: business._id, sku: 'SRV', name: 'Consultoría', trackInventory: false });

      const result = await executeToolCall(toolCall('check_stock', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result).toEqual({ success: true, productId: producto._id, trackInventory: false, availability: 'NOT_TRACKED' });
    });

    test('sin productId, pero con conversation.activeProduct: usa el producto activo (documento §21)', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', physicalStock: 0 });
      conversation.activeProduct = { productId: producto._id, name: 'A', lastSearchQuery: 'a', updatedAt: new Date() };

      const result = await executeToolCall(toolCall('check_stock', {}), { conversation, business, lead: null });

      expect(result.success).toBe(true);
      expect(result.inStock).toBe(false);
    });

    test('sin productId y sin activeProduct: success:false, no lanza', async () => {
      const result = await executeToolCall(toolCall('check_stock', {}), { conversation, business, lead: null });
      expect(result).toEqual({ success: false, error: expect.stringContaining('search_products') });
    });

    test('producto de otro negocio (aunque el id sea válido): success:false, nunca expone el dato ajeno', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const producto = await Product.create({ business: otroBusiness._id, sku: 'A', name: 'A', physicalStock: 999 });

      const result = await executeToolCall(toolCall('check_stock', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result.success).toBe(false);
      expect(result.physicalStock).toBeUndefined();
    });

    test('producto desactivado: success:false, no revela que existió', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', active: false });

      const result = await executeToolCall(toolCall('check_stock', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result.success).toBe(false);
    });

    test('id malformado (no un ObjectId real): success:false, no lanza ni tira 500', async () => {
      const result = await executeToolCall(toolCall('check_stock', { productId: 'no-es-un-id-valido' }), { conversation, business, lead: null });
      expect(result.success).toBe(false);
    });
  });

  describe('get_price — regla anti-alucinación (documento §22)', () => {
    test('con precio cargado: lo devuelve real', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', price: 50, currency: 'PEN' });

      const result = await executeToolCall(toolCall('get_price', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result).toEqual({ success: true, productId: producto._id, price: 50, currency: 'PEN', priceAvailable: true });
    });

    test('sin precio cargado: priceAvailable:false — nunca un número inventado', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });

      const result = await executeToolCall(toolCall('get_price', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result).toEqual({ success: true, productId: producto._id, priceAvailable: false });
    });

    test('resuelve currency al fallback del negocio si el producto no tiene una propia', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', price: 30 });

      const result = await executeToolCall(toolCall('get_price', { productId: producto._id.toString() }), { conversation, business, lead: null });

      expect(result.currency).toBe(business.currency); // 'MXN' por default
    });

    test('sin productId y sin activeProduct: success:false, no lanza', async () => {
      const result = await executeToolCall(toolCall('get_price', {}), { conversation, business, lead: null });
      expect(result.success).toBe(false);
    });

    test('usa conversation.activeProduct como fallback, igual que check_stock', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', price: 15 });
      conversation.activeProduct = { productId: producto._id, name: 'A', lastSearchQuery: 'a', updatedAt: new Date() };

      const result = await executeToolCall(toolCall('get_price', {}), { conversation, business, lead: null });

      expect(result).toMatchObject({ success: true, price: 15, priceAvailable: true });
    });
  });

  test('argumentos con JSON malformado: fail-soft genérico de executeToolCall(), no lanza', async () => {
    const malformado = { id: 'call_x', function: { name: 'get_price', arguments: '{invalido' } };
    const result = await executeToolCall(malformado, { conversation, business, lead: null });
    expect(result.success).toBe(false);
  });
});
