// Bloque A del diagnóstico post-hardening (docs/post-hardening-diagnostico/,
// 16-17/sep/2026): prueba end-to-end de que agotar rateLimitGeneral con
// tráfico normal de dashboard NO bloquea un login posterior del mismo
// usuario. Contra la app real (supertest + app.js real, mismos limiters
// reales montados) — no mockea rateLimit.middleware.js, solo auth.service
// para el login final (mismo patrón que auth.criticalFlow.e2e.test.js).
jest.mock('../modules/auth/auth.service', () => ({
  registrar: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  refreshAccessToken: jest.fn(),
  forgotPassword: jest.fn(),
  resetPassword: jest.fn(),
  verifyEmail: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const authService = require('../modules/auth/auth.service');
const { JWT_SECRET } = require('../config/env');

describe('rateLimitGeneral vs rateLimitAuthGeneral — baldes separados', () => {
  test('agotar el balde de negocio con tráfico tipo dashboard (Leads→Pipeline→Stats) no bloquea un login posterior del mismo usuario', async () => {
    // Token con firma real y válida (mismo JWT_SECRET que usa la app) —
    // simula el access token en memoria que apiFetch adjunta a TODA
    // request, incluida /auth/login (comportamiento previo al fix).
    const token = jwt.sign({ sub: 'usuario-de-prueba-rate-limit' }, JWT_SECRET, { expiresIn: '15m' });
    const authHeader = `Bearer ${token}`;

    // Simula ~15 "cargas de página" con 7 requests en paralelo cada una
    // (Leads + Pipeline + Stats + notificaciones + whatsapp/status, etc.)
    // — 105 requests en total, por encima del máximo de rateLimitGeneral
    // (100/15min). Pega a una ruta bajo /api/v1 que no requiere Mongo real:
    // rateLimitGeneral corre ANTES de cualquier ruteo real (app.js), así
    // que ni siquiera necesita existir para que el limiter actúe.
    const respuestas = [];
    for (let pagina = 0; pagina < 15; pagina++) {
      const burst = await Promise.all(
        Array.from({ length: 7 }, () =>
          request(app).get('/api/v1/leads').set('Authorization', authHeader),
        ),
      );
      respuestas.push(...burst);
    }

    const bloqueadasPorRateLimitGeneral = respuestas.filter((r) => r.status === 429);
    // Confirma que el escenario realmente agotó el balde (si esto no fuera
    // cierto, el resto del test no probaría nada).
    expect(bloqueadasPorRateLimitGeneral.length).toBeGreaterThan(0);

    // El login del MISMO usuario (mismo `sub`, mismo Authorization header
    // todavía adjunto) debe funcionar normal — rateLimitAuthGeneral es un
    // balde propio, no comparte presupuesto con rateLimitGeneral.
    authService.login.mockResolvedValue({
      accessToken: 'access-nuevo',
      refreshToken: 'refresh-nuevo',
      usuario: { _id: 'usuario-de-prueba-rate-limit', email: 'owner@example.com' },
    });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('Authorization', authHeader)
      .send({ email: 'owner@example.com', password: 'Password1' });

    expect(login.status).toBe(200);
    expect(authService.login).toHaveBeenCalled();
  }, 30000);
});
