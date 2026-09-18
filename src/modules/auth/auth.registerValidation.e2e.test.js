// Test real (Jest, e2e contra la app real) — Falla 1 del diagnóstico
// original (registro de tenant nuevo, docs/post-hardening-diagnostico/ en
// creaos-backend, 18/sep/2026). Reproducido en producción: contraseña
// "lunalizeth2011" (14 caracteres, con números, SIN mayúscula) — cumple
// el mínimo de 6 que hasta ahora exigía el frontend, pero no la regla
// real del backend (min 8 + mayúscula + número), y el 422 resultante se
// mostraba como "Datos inválidos"/"Error de validación en los datos
// enviados" genérico, sin decir cuál requisito faltaba.
//
// Mismo patrón que auth.criticalFlow.e2e.test.js: supertest contra la
// app real (validarRegistro + validate corren de verdad, sin mockear),
// solo auth.service se mockea — así se prueba la validación real de
// punta a punta, sin necesitar Mongo.
jest.mock('./auth.service', () => ({
  registrar: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  refreshAccessToken: jest.fn(),
  forgotPassword: jest.fn(),
  resetPassword: jest.fn(),
  verifyEmail: jest.fn(),
}));

const request = require('supertest');
const app = require('../../app');
const authService = require('./auth.service');

describe('POST /api/v1/auth/register — validación de contraseña', () => {
  beforeEach(() => jest.clearAllMocks());

  const bodyBase = {
    name: 'Luna Lizeth',
    email: 'luna@example.com',
    businessName: 'Negocio de Luna',
  };

  test('contraseña sin mayúscula (reproducción real: "lunalizeth2011"): 422, con el mensaje ESPECÍFICO en errors[], no solo el genérico', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...bodyBase, password: 'lunalizeth2011' })
      .expect(422);

    expect(res.body.success).toBe(false);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'password', mensaje: 'Debe contener al menos una mayúscula' }),
      ]),
    );
    expect(authService.registrar).not.toHaveBeenCalled();
  });

  test('contraseña de menos de 8 caracteres (cumplía el mínimo viejo del frontend, de 6): 422, mensaje específico de longitud', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...bodyBase, password: 'Ab1cdef' }) // 7 caracteres, mayúscula y número OK
      .expect(422);

    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'password', mensaje: 'La contraseña debe tener al menos 8 caracteres' }),
      ]),
    );
  });

  test('contraseña sin ningún número: 422, mensaje específico de número', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...bodyBase, password: 'Lunalizeth' }) // 10 caracteres, mayúscula OK, sin número
      .expect(422);

    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'password', mensaje: 'Debe contener al menos un número' }),
      ]),
    );
  });

  test('contraseña que cumple los 3 requisitos (8+, mayúscula, número): 201, registrar() se llama', async () => {
    authService.registrar.mockResolvedValue({
      usuario: { _id: 'u1', email: 'luna@example.com', isEmailVerified: false },
    });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...bodyBase, password: 'Lunalizeth2011' }) // 14 caracteres, mayúscula, número
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(authService.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'luna@example.com', password: 'Lunalizeth2011' }),
    );
  });
});
