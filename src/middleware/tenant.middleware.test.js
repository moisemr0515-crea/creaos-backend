// Test real (Jest) de tenant.middleware.js — agregado junto con el cache
// de Redis (17/sep/2026, diagnóstico de lentitud percibida,
// docs/post-hardening-diagnostico/). Todo mockeado (Business, authCache)
// — este archivo no toca Mongo ni Redis reales, es lógica pura de
// middleware. Mismo patrón que auth.middleware.test.js.
jest.mock('../modules/businesses/business.model', () => ({ findOne: jest.fn() }));
jest.mock('./authCache', () => ({
  obtenerNegocioCacheado: jest.fn(),
  guardarNegocioCacheado: jest.fn(),
}));

const Business = require('../modules/businesses/business.model');
const { obtenerNegocioCacheado, guardarNegocioCacheado } = require('./authCache');
const { injectTenant } = require('./tenant.middleware');

function mockReq(overrides = {}) {
  return { user: { business: 'b1' }, businessId: undefined, ...overrides };
}

function negocioMock(overrides = {}) {
  return { _id: 'b1', name: 'Negocio de prueba', ...overrides };
}

describe('tenant.middleware#injectTenant()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sin req.user.business ni req.businessId: 400', async () => {
    const next = jest.fn();
    await injectTenant(mockReq({ user: {}, businessId: undefined }), {}, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(Business.findOne).not.toHaveBeenCalled();
  });

  test('cache MISS: consulta Mongo, guarda en cache, adjunta req.business/req.businessId', async () => {
    obtenerNegocioCacheado.mockResolvedValue(null);
    const negocio = negocioMock();
    Business.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(negocio) });
    const next = jest.fn();
    const req = mockReq();

    await injectTenant(req, {}, next);

    expect(obtenerNegocioCacheado).toHaveBeenCalledWith('b1');
    expect(Business.findOne).toHaveBeenCalledWith({ _id: 'b1', isActive: true });
    expect(guardarNegocioCacheado).toHaveBeenCalledWith('b1', negocio);
    expect(req.business).toBe(negocio);
    expect(req.businessId).toBe('b1');
    expect(next).toHaveBeenCalledWith();
  });

  test('cache HIT: NO consulta Mongo, usa el negocio cacheado', async () => {
    const negocio = negocioMock();
    obtenerNegocioCacheado.mockResolvedValue(negocio);
    const next = jest.fn();
    const req = mockReq();

    await injectTenant(req, {}, next);

    expect(Business.findOne).not.toHaveBeenCalled();
    expect(guardarNegocioCacheado).not.toHaveBeenCalled();
    expect(req.business).toBe(negocio);
    expect(next).toHaveBeenCalledWith();
  });

  test('negocio no existe/inactivo (cache miss + Mongo null): 403, no cachea nada', async () => {
    obtenerNegocioCacheado.mockResolvedValue(null);
    Business.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const next = jest.fn();

    await injectTenant(mockReq(), {}, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(guardarNegocioCacheado).not.toHaveBeenCalled();
  });

  test('req.businessId (del JWT) se usa como fallback cuando req.user.business no viene poblado', async () => {
    obtenerNegocioCacheado.mockResolvedValue(negocioMock({ _id: 'b2' }));
    const next = jest.fn();
    const req = mockReq({ user: {}, businessId: 'b2' });

    await injectTenant(req, {}, next);

    expect(obtenerNegocioCacheado).toHaveBeenCalledWith('b2');
    expect(req.businessId).toBe('b2');
  });
});
