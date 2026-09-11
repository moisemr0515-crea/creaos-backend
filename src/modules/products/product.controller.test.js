// Test real (Jest, Mongo real) de product.controller.js — CREA Product
// Intelligence™ V1.0, Etapa 3/10. Mismo patrón que channel.controller.test.js:
// se invoca el controller directamente con req/res/next mockeados, sin pasar
// por Express ni por los middlewares de auth/tenant/rbac (esos ya tienen su
// propia cobertura genérica) — el foco acá es: validación (Joi, sección 11
// del documento maestro), delegación correcta a product.service.js, y que
// `business` SIEMPRE salga de `req.businessId`, nunca de algo que el cliente
// mande en el body/query.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const {
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
  deactivateProduct,
} = require('./product.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_controller';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const actorReq = (overrides = {}) => ({
  user: { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' },
  body: {},
  query: {},
  params: {},
  ...overrides,
});

describe('product.controller', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  describe('createProduct', () => {
    test('201 con datos válidos, persiste scoped al negocio del request', async () => {
      const req = actorReq({ businessId: business._id, body: { sku: 'mor-001', name: 'Moringa 100 cápsulas', price: 50 } });
      const res = mockRes();
      const next = jest.fn();

      await createProduct(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.producto.sku).toBe('MOR-001');

      const enDb = await Product.findById(body.data.producto._id);
      expect(enDb.business.toString()).toBe(business._id.toString());
    });

    test('ignora un `business`/`source` enviado en el body — siempre usa req.businessId y source:"manual"', async () => {
      const otroBusinessId = new mongoose.Types.ObjectId();
      const req = actorReq({
        businessId: business._id,
        body: { sku: 'A', name: 'A', business: otroBusinessId.toString(), source: 'import' },
      });
      const res = mockRes();
      const next = jest.fn();

      await createProduct(req, res, next);

      const body = res.json.mock.calls[0][0];
      const enDb = await Product.findById(body.data.producto._id);
      expect(enDb.business.toString()).toBe(business._id.toString());
      expect(enDb.source).toBe('manual');
    });

    test.each([
      ['SKU vacío', { sku: '', name: 'Producto' }],
      ['nombre vacío', { sku: 'A', name: '' }],
      ['SKU faltante', { name: 'Producto' }],
      ['nombre faltante', { sku: 'A' }],
      ['precio negativo', { sku: 'A', name: 'Producto', price: -10 }],
      ['stock negativo', { sku: 'A', name: 'Producto', physicalStock: -5 }],
      ['moneda inválida (no ISO 4217)', { sku: 'A', name: 'Producto', currency: 'PESOS' }],
    ])('rechaza con 400: %s', async (_desc, body) => {
      const req = actorReq({ businessId: business._id, body });
      const res = mockRes();
      const next = jest.fn();

      await createProduct(req, res, next);

      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('SKU duplicado en el mismo negocio: 409, propagado desde el service', async () => {
      await Product.create({ business: business._id, sku: 'A', name: 'Existente' });

      const req = actorReq({ businessId: business._id, body: { sku: 'a', name: 'Otro' } });
      const res = mockRes();
      const next = jest.fn();

      await createProduct(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  describe('getProduct', () => {
    test('200 con el producto', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      const req = actorReq({ businessId: business._id, params: { id: producto._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await getProduct(req, res, next);

      expect(res.status).not.toHaveBeenCalledWith(404);
      expect(res.json.mock.calls[0][0].data.producto._id.toString()).toBe(producto._id.toString());
    });

    test('404 si el producto es de otro negocio (aislamiento por tenant)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const producto = await Product.create({ business: otroBusiness._id, sku: 'A', name: 'A' });

      const req = actorReq({ businessId: business._id, params: { id: producto._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await getProduct(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('listProducts', () => {
    test('pagina con meta y filtra por search', async () => {
      await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa', keywords: ['moringa'] });
      await Product.create({ business: business._id, sku: 'ACE-001', name: 'Aceite de coco' });

      const req = actorReq({ businessId: business._id, query: { search: 'moringa' } });
      const res = mockRes();
      const next = jest.fn();

      await listProducts(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.productos).toHaveLength(1);
      expect(body.data.productos[0].sku).toBe('MOR-001');
      expect(body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
    });

    test('query inválida (page negativo) → 400', async () => {
      const req = actorReq({ businessId: business._id, query: { page: -1 } });
      const res = mockRes();
      const next = jest.fn();

      await listProducts(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('updateProduct', () => {
    test('actualiza campos válidos', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A', price: 10 });
      const req = actorReq({ businessId: business._id, params: { id: producto._id.toString() }, body: { price: 99 } });
      const res = mockRes();
      const next = jest.fn();

      await updateProduct(req, res, next);

      expect(res.json.mock.calls[0][0].data.producto.price).toBe(99);
    });

    test('body vacío → 400 (Joi .min(1))', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      const req = actorReq({ businessId: business._id, params: { id: producto._id.toString() }, body: {} });
      const res = mockRes();
      const next = jest.fn();

      await updateProduct(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('no puede editar un producto de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const producto = await Product.create({ business: otroBusiness._id, sku: 'A', name: 'A' });

      const req = actorReq({ businessId: business._id, params: { id: producto._id.toString() }, body: { price: 1 } });
      const res = mockRes();
      const next = jest.fn();

      await updateProduct(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('deactivateProduct', () => {
    test('DELETE desactiva (active:false), nunca borra el documento', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      const req = actorReq({ businessId: business._id, params: { id: producto._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await deactivateProduct(req, res, next);

      expect(res.json.mock.calls[0][0].data.producto.active).toBe(false);
      const enDb = await Product.findById(producto._id);
      expect(enDb).not.toBeNull();
      expect(enDb.active).toBe(false);
    });
  });
});
