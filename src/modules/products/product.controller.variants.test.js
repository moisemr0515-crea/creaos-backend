// Test real (Jest, Mongo real) de los 4 endpoints de variantes en
// product.controller.js — Bloque 4 de la auditoría Business Brain (§61,
// 20/sep/2026). Mismo patrón que product.controller.test.js: controller
// invocado directo con req/res/next mockeados, foco en validación Joi,
// aislamiento por tenant (req.businessId, nunca params/body), y
// delegación correcta a productInventory.service.js.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const Variant = require('./variant.model');
const {
  createVariant,
  listVariants,
  updateVariant,
  deactivateVariant,
} = require('./product.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_controller_variants';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const req = (overrides = {}) => ({
  user: { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' },
  body: {},
  query: {},
  params: {},
  ...overrides,
});

describe('product.controller — variantes (Bloque 4, §61)', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    producto = await Product.create({ business: business._id, sku: 'REMERA-001', name: 'Remera básica' });
  });

  describe('createVariant', () => {
    test('201, valida con Joi, crea la variante y marca hasVariants:true', async () => {
      const next = jest.fn();
      const res = mockRes();

      await createVariant(
        req({ businessId: business._id, params: { id: producto._id.toString() }, body: { sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo', talla: 'M' }, physicalStock: 10 } }),
        res,
        next
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      const productoActualizado = await Product.findById(producto._id);
      expect(productoActualizado.hasVariants).toBe(true);
    });

    test('sin atributos: 400 vía Joi (min(1) en el objeto), nunca crea la variante', async () => {
      const next = jest.fn();

      await createVariant(
        req({ businessId: business._id, params: { id: producto._id.toString() }, body: { sku: 'X', attributes: {} } }),
        mockRes(),
        next
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(await Variant.countDocuments({ product: producto._id })).toBe(0);
    });

    test('producto de OTRO negocio (req.businessId real, nunca uno del body): 404', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const next = jest.fn();

      await createVariant(
        req({ businessId: otroBusiness._id, params: { id: producto._id.toString() }, body: { sku: 'X', attributes: { color: 'Rojo' } } }),
        mockRes(),
        next
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('listVariants', () => {
    test('devuelve TODAS las variantes (activas e inactivas) del producto', async () => {
      await createVariant(req({ businessId: business._id, params: { id: producto._id.toString() }, body: { sku: 'A', attributes: { color: 'Rojo' } } }), mockRes(), jest.fn());
      await createVariant(req({ businessId: business._id, params: { id: producto._id.toString() }, body: { sku: 'B', attributes: { color: 'Azul' } } }), mockRes(), jest.fn());

      const res = mockRes();
      const next = jest.fn();
      await listVariants(req({ businessId: business._id, params: { id: producto._id.toString() } }), res, next);

      expect(next).not.toHaveBeenCalled();
      const payload = res.json.mock.calls[0][0];
      expect(payload.data.variantes).toHaveLength(2);
    });
  });

  describe('updateVariant', () => {
    test('actualiza precio/stock de una variante puntual', async () => {
      const resCrear = mockRes();
      await createVariant(req({ businessId: business._id, params: { id: producto._id.toString() }, body: { sku: 'A', attributes: { color: 'Rojo' } } }), resCrear, jest.fn());
      const variantId = resCrear.json.mock.calls[0][0].data.variante._id;

      const res = mockRes();
      const next = jest.fn();
      await updateVariant(
        req({ businessId: business._id, params: { id: producto._id.toString(), variantId: variantId.toString() }, body: { price: 45 } }),
        res,
        next
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].data.variante.price).toBe(45);
    });
  });

  describe('deactivateVariant', () => {
    test('nunca borra — solo pone active:false', async () => {
      const resCrear = mockRes();
      await createVariant(req({ businessId: business._id, params: { id: producto._id.toString() }, body: { sku: 'A', attributes: { color: 'Rojo' } } }), resCrear, jest.fn());
      const variantId = resCrear.json.mock.calls[0][0].data.variante._id;

      const next = jest.fn();
      await deactivateVariant(req({ businessId: business._id, params: { id: producto._id.toString(), variantId: variantId.toString() } }), mockRes(), next);

      expect(next).not.toHaveBeenCalled();
      const releida = await Variant.findById(variantId);
      expect(releida.active).toBe(false);
    });
  });
});
