// FASE 3 / ETAPA C — GET /businesses/current/ai-readiness (solo lectura, aislado por tenant).
const mongoose = require('mongoose');
const Business = require('./business.model');
const Product = require('../products/product.model');
const controller = require('./business.controller');
const router = require('./business.routes');

const res = () => { const r = { status: jest.fn(() => r), json: jest.fn(() => r) }; return r; };

describe('business.controller#getAiReadiness', () => {
  beforeAll(async () => mongoose.connect('mongodb://localhost:27017/creaos_test_ai_readiness_endpoint'));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => { await Promise.all([Business.deleteMany({}), Product.deleteMany({})]); });

  test('la ruta existe y exige businesses:read', () => {
    const capa = router.stack.find((l) => l.route?.path === '/current/ai-readiness');
    expect(capa.route.methods.get).toBe(true);
    expect(capa.route.stack.length).toBeGreaterThanOrEqual(2); // checkPermission + controlador
  });

  test('devuelve el estado del negocio del request, sin tocar nada', async () => {
    const negocio = await Business.create({ name: 'Negocio de prueba' });
    const otro = await Business.create({ name: 'Otro negocio' });
    await Product.create({ business: otro._id, name: 'Ajeno', sku: 'SKU-AJENO-1', price: 1, stock: 1, active: true });
    const antes = await Business.findById(negocio._id).lean();

    const r = res();
    const next = jest.fn();
    await controller.getAiReadiness({ businessId: negocio._id }, r, next);

    expect(next).not.toHaveBeenCalled();
    const { data } = r.json.mock.calls[0][0];
    expect(data.readiness.businessId).toBe(String(negocio._id));
    expect(data.readiness.ready).toEqual({ knowledge: false, material: false });
    expect(data.readiness.knowledge.items.find((i) => i.key === 'catalog').count).toBe(0); // el producto es de otro negocio
    expect(await Business.findById(negocio._id).lean()).toEqual(antes);
  });

  test('negocio inexistente ⇒ 404 por next()', async () => {
    const next = jest.fn();
    await controller.getAiReadiness({ businessId: new mongoose.Types.ObjectId() }, res(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
  });
});
