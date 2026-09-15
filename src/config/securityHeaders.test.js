const express = require('express');
const helmet = require('helmet');
const request = require('supertest');
const { helmetOptions } = require('./securityHeaders');

describe('headers de seguridad', () => {
  test('envía una CSP estricta en las respuestas de la API', async () => {
    const app = express();
    app.use(helmet(helmetOptions));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const response = await request(app).get('/test').expect(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
