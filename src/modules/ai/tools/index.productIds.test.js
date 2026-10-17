// Ids de producto inventados por el modelo (p. ej. "aceite_de_moringa_qhali_kausay", visto en producción con get_price):
// ninguna tool debe dejar pasar un CastError de Mongo; el id inválido se reemplaza por el producto activo o se devuelve un
// error claro que le dice al modelo qué hacer. Mongo real, vía executeToolCall() (el mismo punto de entrada que generateReply()).
const mongoose = require('mongoose');
const logger = require('../../../utils/logger');
const Business = require('../../businesses/business.model');
const Product = require('../../products/product.model');
const Variant = require('../../products/variant.model');
const Conversation = require('../conversation.model');
const { buildSystemPrompt } = require('../ai.service');

// search_business_knowledge pide embeddings reales; aquí no interesan (ver index.businessKnowledge.test.js).
jest.mock('../../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const { TOOL_REGISTRY, executeToolCall } = require('./index');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_product_ids';
const SLUG = 'aceite_de_moringa_qhali_kausay';
const SOLO_12_CARACTERES = '123456789012'; // mongoose.isValidObjectId lo daría por bueno

const toolCall = (name, args) => ({ id: 'call_test_1', function: { name, arguments: JSON.stringify(args) } });
const MONGO_FILTRADO = /Cast to|ObjectId failed|BSONError|at path/i;

describe('ai/tools — ids de producto inventados', () => {
  let business;
  let conversation;
  let errorSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await Conversation.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
    conversation = new Conversation({ business: business._id, lead: new mongoose.Types.ObjectId(), channel: 'whatsapp' });
  });

  const conProductoActivo = async (extra = {}) => {
    const producto = await Product.create({ business: business._id, sku: 'ACE-1', name: 'Aceite de Moringa', price: 80, currency: 'PEN', physicalStock: 7, ...extra });
    conversation.activeProduct = { productId: producto._id, name: producto.name, lastSearchQuery: 'aceite', updatedAt: new Date() };
    return producto;
  };

  describe.each(['get_price', 'check_stock', 'send_product_photos'])('%s con un id inventado y SIN producto activo', (nombre) => {
    test.each([[SLUG], [SOLO_12_CARACTERES], ['{"$ne":null}']])('"%s": error claro, sin texto de Mongo, sin log de error', async (basura) => {
      const result = await executeToolCall(toolCall(nombre, { productId: basura }), { conversation, business, lead: null });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/search_products/);
      expect(result.error).toMatch(/24 caracteres/);
      expect(JSON.stringify(result)).not.toMatch(MONGO_FILTRADO);
      expect(errorSpy).not.toHaveBeenCalled(); // antes: "error ejecutando tool ...: Cast to ObjectId failed"
    });
  });

  test('el error no es enorme aunque el modelo mande un texto larguísimo', async () => {
    const result = await executeToolCall(toolCall('get_price', { productId: 'x'.repeat(5000) }), { conversation, business, lead: null });
    expect(result.error.length).toBeLessThan(500);
  });

  test('get_price con un id inventado y CON producto activo: responde con el activo (precio real del catálogo)', async () => {
    const producto = await conProductoActivo();

    const result = await executeToolCall(toolCall('get_price', { productId: SLUG }), { conversation, business, lead: null });

    expect(result).toMatchObject({ success: true, price: 80, currency: 'PEN', priceAvailable: true });
    expect(String(result.productId)).toBe(String(producto._id));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('check_stock con un id inventado y CON producto activo: usa el activo', async () => {
    await conProductoActivo();
    const result = await executeToolCall(toolCall('check_stock', { productId: SLUG }), { conversation, business, lead: null });
    expect(result).toMatchObject({ success: true, physicalStock: 7, inStock: true });
  });

  test('send_product_photos con un id inventado y CON producto activo: usa el activo (aquí sin foto cargada)', async () => {
    await conProductoActivo();
    const result = await executeToolCall(toolCall('send_product_photos', { productId: SLUG }), { conversation, business, lead: null });
    expect(result).toMatchObject({ success: false, status: 'asset_missing' });
  });

  test('un id real sigue ganando sobre el producto activo (no se pisa lo que el modelo eligió bien)', async () => {
    await conProductoActivo();
    const otro = await Product.create({ business: business._id, sku: 'OTRO', name: 'Otro', price: 15, currency: 'PEN' });
    const result = await executeToolCall(toolCall('get_price', { productId: otro._id.toString() }), { conversation, business, lead: null });
    expect(result).toMatchObject({ success: true, price: 15 });
  });

  test('variantId inventado: se ignora y, si el producto tiene variantes, llega la lista para elegir (no un CastError)', async () => {
    const conVariantes = await Product.create({ business: business._id, sku: 'REM', name: 'Remera', hasVariants: true });
    await Variant.create({ business: business._id, product: conVariantes._id, sku: 'REM-R', attributes: { color: 'Rojo' }, price: 45, physicalStock: 3 });

    const result = await executeToolCall(
      toolCall('get_price', { productId: conVariantes._id.toString(), variantId: SLUG }),
      { conversation, business, lead: null }
    );

    expect(result).toMatchObject({ success: true, needsVariantSelection: true });
    expect(JSON.stringify(result)).not.toMatch(MONGO_FILTRADO);
  });

  test('variantId inventado en un producto SIN variantes: se ignora igual que si no viniera', async () => {
    const producto = await conProductoActivo();
    const result = await executeToolCall(toolCall('check_stock', { productId: producto._id.toString(), variantId: SLUG }), { conversation, business, lead: null });
    expect(result).toMatchObject({ success: true, physicalStock: 7 });
  });

  test('search_business_knowledge con productIds inventados: no revienta y no manda el id inventado a la consulta', async () => {
    const result = await executeToolCall(toolCall('search_business_knowledge', { query: 'devolución', productIds: [SLUG] }), { conversation, business, lead: null });
    expect(result.success).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('un id real de OTRO negocio sigue sin exponer nada (el aislamiento por tenant no cambió)', async () => {
    const otroNegocio = await Business.create({ name: 'Otro negocio' });
    const ajeno = await Product.create({ business: otroNegocio._id, sku: 'A', name: 'Ajeno', price: 1, physicalStock: 999 });
    const result = await executeToolCall(toolCall('check_stock', { productId: ajeno._id.toString() }), { conversation, business, lead: null });
    expect(result.success).toBe(false);
    expect(result.physicalStock).toBeUndefined();
  });

  describe('contrato sobre TOOL_REGISTRY: todo parámetro de id rechaza basura sin filtrar errores de Mongo', () => {
    const esParametroDeId = (nombre) => /Ids?$/.test(nombre);
    const herramientasConId = TOOL_REGISTRY.filter((t) => Object.keys(t.inputSchema.properties || {}).some(esParametroDeId));

    test('el contrato no es vacío: cubre al menos las tools de producto y de conocimiento', () => {
      expect(herramientasConId.map((t) => t.name)).toEqual(expect.arrayContaining(['check_stock', 'get_price', 'send_product_photos', 'search_business_knowledge']));
    });

    test.each(herramientasConId.map((t) => [t.name]))('%s', async (nombre) => {
      const tool = TOOL_REGISTRY.find((t) => t.name === nombre);
      const args = { query: 'algo' }; // algunas tools exigen query además del id
      for (const [propiedad, definicion] of Object.entries(tool.inputSchema.properties)) {
        if (esParametroDeId(propiedad)) args[propiedad] = definicion.type === 'array' ? [SLUG] : SLUG;
      }

      const result = await executeToolCall(toolCall(nombre, args), { conversation, business, lead: null });

      expect(JSON.stringify(result)).not.toMatch(MONGO_FILTRADO);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('prompt: el producto activo lleva su productId para que el modelo no lo invente', () => {
    test('el bloque "CONTEXTO DE PRODUCTO" incluye el productId exacto', () => {
      const productId = new mongoose.Types.ObjectId();
      const prompt = buildSystemPrompt({ name: 'N' }, { name: 'L' }, null, { productId, name: 'Aceite de Moringa', lastSearchQuery: 'aceite' });
      expect(prompt).toContain(`productId: ${productId}`);
      expect(prompt).toMatch(/nunca uno armado a partir del nombre/);
    });
  });
});
