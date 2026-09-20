// Test real (Jest, Mongo real) de check_stock/get_price/search_products
// variant-aware, vía executeToolCall() — Bloque 4 de la auditoría Business
// Brain (§61, 20/sep/2026). La lógica de resolución ya tiene su propio
// test dedicado en product.service.variants.test.js; este archivo cubre
// el contrato de la tool: que variantId viaja de args al service, y que
// needsVariantSelection llega intacto al modelo.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Product = require('../../products/product.model');
const Variant = require('../../products/variant.model');
const Lead = require('../../leads/lead.model');
const Conversation = require('../conversation.model');
const { executeToolCall } = require('./index');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_variants';

const toolCall = (name, args) => ({ id: 'call_test_1', function: { name, arguments: JSON.stringify(args) } });

describe('ai/tools/index — variant-aware (Bloque 4, §61)', () => {
  let business;
  let producto;
  let variante;
  let conversation;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init(); // el índice de texto tarda en construirse
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});

    business = await Business.create({ name: 'CREA OS', currency: 'PEN' });
    producto = await Product.create({ business: business._id, sku: 'REMERA-001', name: 'Remera básica', hasVariants: true });
    variante = await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M',
      attributes: { color: 'Rojo', talla: 'M' }, price: 45, physicalStock: 10,
    });
    const lead = await Lead.create({ business: business._id, name: 'Lead de prueba' });
    conversation = new Conversation({ business: business._id, lead: lead._id, channel: 'whatsapp' });
  });

  test('search_products: un producto con variantes trae el array "variants" completo', async () => {
    const result = await executeToolCall(toolCall('search_products', { query: 'remera' }), { conversation, business });

    expect(result.matches[0].hasVariants).toBe(true);
    expect(result.matches[0].variants[0]).toMatchObject({ sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo', talla: 'M' } });
  });

  test('check_stock SIN variantId: needsVariantSelection:true, nunca un número ambiguo', async () => {
    const result = await executeToolCall(toolCall('check_stock', { productId: producto._id.toString() }), { conversation, business });

    expect(result).toEqual({
      success: true,
      productId: producto._id,
      needsVariantSelection: true,
      variants: [expect.objectContaining({ sku: 'REMERA-001-ROJO-M' })],
    });
  });

  test('check_stock CON variantId: devuelve el stock de esa variante puntual', async () => {
    const result = await executeToolCall(
      toolCall('check_stock', { productId: producto._id.toString(), variantId: variante._id.toString() }),
      { conversation, business }
    );

    expect(result).toEqual({
      success: true, productId: producto._id, variantId: variante._id,
      trackInventory: true, physicalStock: 10, reservedStock: 0, availableStock: 10, inStock: true, lowStock: false,
    });
  });

  test('get_price CON variantId: usa el precio real de la variante', async () => {
    const result = await executeToolCall(
      toolCall('get_price', { productId: producto._id.toString(), variantId: variante._id.toString() }),
      { conversation, business }
    );

    expect(result).toEqual({ success: true, productId: producto._id, variantId: variante._id, price: 45, currency: 'PEN', priceAvailable: true });
  });

  test('variantId de OTRO negocio: 404 vía executeToolCall, nunca expone stock ajeno', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    const otroProducto = await Product.create({ business: otroBusiness._id, sku: 'X', name: 'X', hasVariants: true });
    const varianteAjena = await Variant.create({ business: otroBusiness._id, product: otroProducto._id, sku: 'AJENA', attributes: {} });

    const result = await executeToolCall(
      toolCall('check_stock', { productId: producto._id.toString(), variantId: varianteAjena._id.toString() }),
      { conversation, business }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Variante no encontrada/);
  });
});
