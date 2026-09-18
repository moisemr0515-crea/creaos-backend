// Test real (Jest, e2e contra la app real) — mismo bug y mismo fix que
// auth.registerValidation.e2e.test.js (Falla 1 del diagnóstico original),
// tratado aparte para reset-password.tsx (18/sep/2026,
// docs/post-hardening-diagnostico/ en creaos-backend): el frontend
// exigía solo 6 caracteres en "Nueva contraseña" (reset-password.tsx),
// pero validarResetPassword usa el MISMO validador que registro (8+,
// mayúscula, número) — mismo patrón de mensaje genérico sin el detalle
// específico.
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

describe('POST /api/v1/auth/reset-password — validación de contraseña', () => {
  beforeEach(() => jest.clearAllMocks());

  test('contraseña sin mayúscula: 422, con el mensaje ESPECÍFICO en errors[]', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-valido', password: 'lunalizeth2011', confirmPassword: 'lunalizeth2011' })
      .expect(422);

    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'password', mensaje: 'Debe contener al menos una mayúscula' }),
      ]),
    );
    expect(authService.resetPassword).not.toHaveBeenCalled();
  });

  test('contraseñas que no coinciden: 422, mensaje específico en confirmPassword', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-valido', password: 'Lunalizeth2011', confirmPassword: 'Otra2011' })
      .expect(422);

    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'confirmPassword', mensaje: 'Las contraseñas no coinciden' }),
      ]),
    );
  });

  test('contraseña que cumple los 3 requisitos y coincide con confirmPassword: 200, resetPassword() se llama', async () => {
    authService.resetPassword.mockResolvedValue();

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-valido', password: 'Lunalizeth2011', confirmPassword: 'Lunalizeth2011' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(authService.resetPassword).toHaveBeenCalledWith({ token: 'token-valido', password: 'Lunalizeth2011' });
  });
});
