// Test real (Jest) de authCache.js — diagnóstico de lentitud percibida
// (17/sep/2026, docs/post-hardening-diagnostico/). Redis mockeado (mismo
// patrón que channel.resolver.js#tryGetCached/trySetCached): lógica pura
// de cache, sin Redis real.
jest.mock('../config/redis');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');
const {
  TTL_SEGUNDOS,
  obtenerUsuarioCacheado,
  guardarUsuarioCacheado,
  invalidarUsuarioCacheado,
  obtenerNegocioCacheado,
  guardarNegocioCacheado,
  invalidarNegocioCacheado,
} = require('./authCache');

function mockRedisOk() {
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  getRedis.mockReturnValue(redis);
  return redis;
}

describe('authCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('TTL_SEGUNDOS es 8 (acordado: corto, para no ser fuente real de inconsistencia)', () => {
    expect(TTL_SEGUNDOS).toBe(8);
  });

  describe('usuario', () => {
    test('obtenerUsuarioCacheado(): hit — devuelve el objeto parseado, con la clave correcta', async () => {
      const redis = mockRedisOk();
      redis.get.mockResolvedValue(JSON.stringify({ _id: 'u1', isActive: true }));

      const resultado = await obtenerUsuarioCacheado('u1');

      expect(redis.get).toHaveBeenCalledWith('authcache:user:u1');
      expect(resultado).toEqual({ _id: 'u1', isActive: true });
    });

    test('obtenerUsuarioCacheado(): miss (null en Redis) — devuelve null, no explota', async () => {
      const redis = mockRedisOk();
      redis.get.mockResolvedValue(null);

      await expect(obtenerUsuarioCacheado('u1')).resolves.toBeNull();
    });

    test('guardarUsuarioCacheado(): setea con EX 8 y la clave correcta', async () => {
      const redis = mockRedisOk();
      redis.set.mockResolvedValue('OK');

      await guardarUsuarioCacheado('u1', { _id: 'u1', isActive: true });

      expect(redis.set).toHaveBeenCalledWith(
        'authcache:user:u1',
        JSON.stringify({ _id: 'u1', isActive: true }),
        'EX',
        8,
      );
    });

    test('guardarUsuarioCacheado(): usa JSON.stringify() directo — funciona igual con un documento de Mongoose (con toJSON) que con un objeto plano', async () => {
      const redis = mockRedisOk();
      redis.set.mockResolvedValue('OK');
      // Simula un documento de Mongoose: toJSON() lo usa JSON.stringify()
      // automáticamente, sin necesidad de llamar a .toObject() a mano.
      const documentoMongoose = { toJSON: () => ({ _id: 'u1', isActive: true }) };

      await guardarUsuarioCacheado('u1', documentoMongoose);

      expect(redis.set).toHaveBeenCalledWith(
        'authcache:user:u1',
        JSON.stringify({ _id: 'u1', isActive: true }),
        'EX',
        8,
      );
    });

    test('invalidarUsuarioCacheado(): borra la clave correcta', async () => {
      const redis = mockRedisOk();
      redis.del.mockResolvedValue(1);

      await invalidarUsuarioCacheado('u1');

      expect(redis.del).toHaveBeenCalledWith('authcache:user:u1');
    });
  });

  describe('negocio', () => {
    test('obtenerNegocioCacheado()/guardarNegocioCacheado()/invalidarNegocioCacheado(): misma lógica, clave distinta (authcache:business:*)', async () => {
      const redis = mockRedisOk();
      redis.get.mockResolvedValue(null);
      redis.set.mockResolvedValue('OK');
      redis.del.mockResolvedValue(1);

      await obtenerNegocioCacheado('b1');
      await guardarNegocioCacheado('b1', { _id: 'b1', name: 'Negocio' });
      await invalidarNegocioCacheado('b1');

      expect(redis.get).toHaveBeenCalledWith('authcache:business:b1');
      expect(redis.set).toHaveBeenCalledWith('authcache:business:b1', JSON.stringify({ _id: 'b1', name: 'Negocio' }), 'EX', 8);
      expect(redis.del).toHaveBeenCalledWith('authcache:business:b1');
    });
  });

  describe('Redis no disponible — best-effort, nunca rompe la request', () => {
    beforeEach(() => {
      getRedis.mockImplementation(() => { throw new Error('Redis no está conectado. Llama connectRedis() primero.'); });
      jest.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logger.warn.mockRestore();
    });

    test('obtenerUsuarioCacheado(): cae a null en vez de propagar el error', async () => {
      await expect(obtenerUsuarioCacheado('u1')).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    test('guardarUsuarioCacheado(): no explota, solo loguea', async () => {
      await expect(guardarUsuarioCacheado('u1', { _id: 'u1' })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    test('invalidarUsuarioCacheado(): no explota — la revocación cae al TTL, no falla la operación que la disparó', async () => {
      await expect(invalidarUsuarioCacheado('u1')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
