const { checkCoreHealth } = require('./health.service');

const mongo = (ping) => ({ readyState: 1, db: { admin: () => ({ ping }) } });
const redis = (ping) => () => ({ ping });

describe('healthcheck de dependencias críticas', () => {
  test('reporta healthy cuando Mongo y Redis responden', async () => {
    await expect(checkCoreHealth({
      mongoConnection: mongo(jest.fn().mockResolvedValue({ ok: 1 })),
      redisProvider: redis(jest.fn().mockResolvedValue('PONG')),
    })).resolves.toEqual({ ok: true, dependencies: { mongo: 'up', redis: 'up' } });
  });

  test('detecta Mongo caído', async () => {
    const result = await checkCoreHealth({
      mongoConnection: { readyState: 0, db: null },
      redisProvider: redis(jest.fn().mockResolvedValue('PONG')),
    });
    expect(result).toEqual({ ok: false, dependencies: { mongo: 'down', redis: 'up' } });
  });

  test('detecta Redis caído', async () => {
    const result = await checkCoreHealth({
      mongoConnection: mongo(jest.fn().mockResolvedValue({ ok: 1 })),
      redisProvider: redis(jest.fn().mockRejectedValue(new Error('offline'))),
    });
    expect(result).toEqual({ ok: false, dependencies: { mongo: 'up', redis: 'down' } });
  });
});
