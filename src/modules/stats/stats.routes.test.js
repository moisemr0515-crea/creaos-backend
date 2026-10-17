// GET /api/v1/stats/summary pegando contra la app real (supertest): permisos por rol, validación de la query y aislamiento por
// negocio. authenticate/injectTenant se simulan con cabeceras de prueba; checkPermission, la validación y el servicio son los reales
// (Mongo real), con los permisos de cada rol tomados de config/constants.
jest.mock('../../middleware/auth.middleware', () => {
  const { ROLE_PERMISSIONS } = require('../../config/constants');
  return {
    authenticate: (req, _res, next) => {
      const slug = req.headers['x-test-role'] || 'owner';
      req.user = { _id: 'user-1', role: { slug, permissions: ROLE_PERMISSIONS[slug] || [] } };
      next();
    },
  };
});
jest.mock('../../middleware/tenant.middleware', () => ({
  injectTenant: (req, _res, next) => {
    req.businessId = req.headers['x-test-business'];
    next();
  },
}));

const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../../app');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const Sale = require('../sales/sale.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_stats_rutas';

describe('GET /api/v1/stats/summary', () => {
  let negocioA;
  let negocioB;
  const actor = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Promise.all([Sale.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([Sale.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    negocioA = await Business.create({ name: 'Negocio A', country: 'PE' });
    negocioB = await Business.create({ name: 'Negocio B', country: 'MX' });
    const [pa, pb] = await Promise.all([Pipeline.createDefault(negocioA._id, actor), Pipeline.createDefault(negocioB._id, actor)]);
    const leadA = await Lead.create({ business: negocioA._id, name: 'Lead A', pipeline: pa._id, potentialValue: 100, closeProbability: 100 });
    const leadB = await Lead.create({ business: negocioB._id, name: 'Lead B', pipeline: pb._id, potentialValue: 5000, closeProbability: 100 });
    const ahora = new Date();
    await Sale.create({ business: negocioA._id, lead: leadA._id, amount: 111, currency: 'PEN', origin: 'manual', status: 'confirmed', closedAt: ahora });
    await Sale.create({ business: negocioB._id, lead: leadB._id, amount: 999, currency: 'MXN', origin: 'manual', status: 'confirmed', closedAt: ahora });
  });

  const get = (negocio, rol, query = '') => {
    const req = request(app).get(`/api/v1/stats/summary${query}`).set('x-test-business', String(negocio._id));
    return rol ? req.set('x-test-role', rol) : req;
  };

  describe('permisos (reports:read)', () => {
    test.each(['owner', 'admin', 'manager', 'viewer'])('%s puede ver las estadísticas', async (rol) => {
      const res = await get(negocioA, rol);
      expect(res.status).toBe(200);
      expect(res.body.data.resumen).toBeDefined();
    });

    test.each(['sales', 'support'])('%s queda fuera: 403 y no se calcula nada', async (rol) => {
      const res = await get(negocioA, rol);
      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/111|PEN/);
    });

    test('un rol desconocido sin permisos: 403', async () => {
      expect((await get(negocioA, 'inventado')).status).toBe(403);
    });
  });

  describe('aislamiento: el negocio sale del token, nunca de la petición', () => {
    test('cada negocio ve solo sus cifras', async () => {
      const a = (await get(negocioA, 'owner')).body.data.resumen;
      const b = (await get(negocioB, 'owner')).body.data.resumen;

      expect(a.vendido.porMoneda).toEqual([expect.objectContaining({ currency: 'PEN', total: 111 })]);
      expect(a.enConversaciones.totalPotencial).toBe(100);
      expect(b.vendido.porMoneda).toEqual([expect.objectContaining({ currency: 'MXN', total: 999 })]);
      expect(b.enConversaciones.totalPotencial).toBe(5000);
    });

    test('un businessId / tenantId en la query o cabeceras NO cambia de negocio', async () => {
      const res = await get(negocioA, 'owner', `?businessId=${negocioB._id}&tenantId=${negocioB._id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.resumen.vendido.porMoneda[0]).toMatchObject({ currency: 'PEN', total: 111 });
      expect(JSON.stringify(res.body)).not.toContain('999');
    });
  });

  describe('validación de la query', () => {
    test('sin parámetros: this_month por defecto', async () => {
      const res = await get(negocioA, 'owner');
      expect(res.body.data.resumen.period).toMatchObject({ key: 'this_month', timezone: 'America/Lima', timezoneConfigured: true });
    });

    test('last_month y custom válidos', async () => {
      expect((await get(negocioA, 'owner', '?period=last_month')).body.data.resumen.period.key).toBe('last_month');
      const custom = await get(negocioA, 'owner', '?period=custom&from=2026-10-01&to=2026-10-31');
      expect(custom.status).toBe(200);
      expect(custom.body.data.resumen.period).toMatchObject({ key: 'custom', from: '2026-10-01T05:00:00.000Z', to: '2026-11-01T05:00:00.000Z' });
    });

    test.each([
      ['?period=semana'],
      ['?period=custom'],
      ['?period=custom&from=2026-10-01'],
      ['?period=custom&from=2026-10-10&to=2026-10-01'],
      ['?period=custom&from=2026-02-31&to=2026-03-01'],
      ['?period=custom&from=hoy&to=2026-03-01'],
      ['?period=custom&from=2020-01-01&to=2026-10-01'],
    ])('%s → 400', async (query) => {
      const res = await get(negocioA, 'owner', query);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  test('la respuesta trae la forma que usará la pantalla', async () => {
    const r = (await get(negocioA, 'owner')).body.data.resumen;
    expect(Object.keys(r).sort()).toEqual(['businessCurrency', 'enConversaciones', 'period', 'porConfirmar', 'sinMonto', 'vendido']);
    expect(r.businessCurrency).toBe('PEN');
    expect(Object.keys(r.enConversaciones).sort()).toEqual(['count', 'listosParaCerrar', 'top', 'totalPotencial', 'valorEsperado']);
  });
});
