jest.mock('./health/health.service', () => ({ checkCoreHealth: jest.fn() }));

const request = require('supertest');
const { checkCoreHealth } = require('./health/health.service');
const app = require('./app');

describe('GET /health', () => {
  test('devuelve 503 cuando una dependencia crítica está caída', async () => {
    checkCoreHealth.mockResolvedValue({ ok: false, dependencies: { mongo: 'down', redis: 'up' } });

    const response = await request(app).get('/health').expect(503);

    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      status: 'degraded',
      dependencies: { mongo: 'down', redis: 'up' },
    }));
  });

  test('devuelve 200 solo cuando Mongo y Redis responden', async () => {
    checkCoreHealth.mockResolvedValue({ ok: true, dependencies: { mongo: 'up', redis: 'up' } });

    const response = await request(app).get('/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
