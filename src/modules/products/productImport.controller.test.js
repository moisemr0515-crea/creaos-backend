// Test real (Jest, Mongo real) de productImport.controller.js — CREA
// Product Intelligence™ V1.0, Etapa 5/10. Mismo patrón que
// product.controller.test.js: controller invocado directo con req/res/next
// mockeados (req.file simulando lo que multer dejaría), sin pasar por
// Express.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const { previewImport, confirmImport } = require('./productImport.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_import_controller';

const HEADERS = ['sku', 'nombre', 'precio'];

const csvFile = (rows, name = 'productos.csv') => ({
  originalname: name,
  buffer: Buffer.from([HEADERS.join(','), ...rows.map((r) => r.join(','))].join('\n'), 'utf8'),
  mimetype: 'text/csv',
  size: 100,
});

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

describe('productImport.controller', () => {
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

  describe('previewImport', () => {
    test('sin archivo (req.file ausente) → 400, no lanza', async () => {
      const req = actorReq({ businessId: business._id });
      const res = mockRes();
      const next = jest.fn();

      await previewImport(req, res, next);

      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('con archivo válido: 200 con resumen y filas, no persiste nada', async () => {
      const req = actorReq({ businessId: business._id, file: csvFile([['A', 'Producto A', '10']]) });
      const res = mockRes();
      const next = jest.fn();

      await previewImport(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.data.resumen).toMatchObject({ totalFilas: 1, validas: 1 });
      expect(await Product.countDocuments({})).toBe(0);
    });
  });

  describe('confirmImport', () => {
    test('sin archivo → 400, no lanza', async () => {
      const req = actorReq({ businessId: business._id });
      const res = mockRes();
      const next = jest.fn();

      await confirmImport(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('con archivo válido: crea productos scoped al negocio del request', async () => {
      const req = actorReq({ businessId: business._id, file: csvFile([['A', 'Producto A', '10']]) });
      const res = mockRes();
      const next = jest.fn();

      await confirmImport(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.data.resumen).toMatchObject({ nuevos: 1, actualizados: 0 });

      const producto = await Product.findOne({ sku: 'A' });
      expect(producto.business.toString()).toBe(business._id.toString());
    });

    test('nunca usa un businessId que no sea req.businessId, aunque el archivo o el body insinúen otro', async () => {
      const otroBusinessId = new mongoose.Types.ObjectId();
      const req = actorReq({
        businessId: business._id,
        body: { businessId: otroBusinessId.toString() },
        file: csvFile([['A', 'Producto A', '10']]),
      });
      const res = mockRes();
      const next = jest.fn();

      await confirmImport(req, res, next);

      const producto = await Product.findOne({ sku: 'A' });
      expect(producto.business.toString()).toBe(business._id.toString());
      expect(producto.business.toString()).not.toBe(otroBusinessId.toString());
    });
  });
});
