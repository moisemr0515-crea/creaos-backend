// Test real (Jest) de auth.middleware.js — agregado junto con el fix del
// incidente del 04/sep/2026 (ver docs/implementation/known-issues.md y
// AUTH_SESSION_INVALID_CODE en error.middleware.js). Todo mockeado (jwt,
// User, config/env) — este archivo no toca Mongo real, es lógica pura de
// middleware.
jest.mock('jsonwebtoken');
jest.mock('../config/env', () => ({ JWT_SECRET: 'secreto-de-prueba' }));
// Mock explícito (no automock) — User es un Model de Mongoose real, dejar
// que Jest lo automockee introspeccionando su prototipo es frágil.
jest.mock('../modules/users/user.model', () => ({ findById: jest.fn() }));

const jwt = require('jsonwebtoken');
const User = require('../modules/users/user.model');
const { authenticate, authenticateUnverified } = require('./auth.middleware');
const { AUTH_SESSION_INVALID_CODE } = require('./error.middleware');

function mockReq(authHeader) {
  return { headers: { authorization: authHeader } };
}

function usuarioMock(overrides = {}) {
  return { _id: 'u1', isActive: true, isEmailVerified: true, ...overrides };
}

describe('auth.middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('authenticate()', () => {
    test('sin header Authorization: AppError 401 con code AUTH_SESSION_INVALID_CODE', async () => {
      const next = jest.fn();
      await authenticate(mockReq(undefined), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE }));
    });

    test('header sin "Bearer ": mismo caso, 401 + code', async () => {
      const next = jest.fn();
      await authenticate(mockReq('Token abc'), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE }));
    });

    test('token expirado (TokenExpiredError de jwt.verify): 401 + code', async () => {
      const err = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      jwt.verify.mockImplementation(() => { throw err; });
      const next = jest.fn();

      await authenticate(mockReq('Bearer expirado'), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE, message: 'El token ha expirado' }));
    });

    test('token inválido (cualquier otro error de jwt.verify): 401 + code', async () => {
      jwt.verify.mockImplementation(() => { throw new Error('jwt malformed'); });
      const next = jest.fn();

      await authenticate(mockReq('Bearer roto'), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE, message: 'Token inválido' }));
    });

    test('token válido pero usuario ya no existe: 401 + code', async () => {
      jwt.verify.mockReturnValue({ sub: 'u1', businessId: 'b1' });
      User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
      const next = jest.fn();

      await authenticate(mockReq('Bearer valido'), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE, message: 'Usuario no encontrado' }));
    });

    test('cuenta desactivada: 403, SIN code (no es "sesión inválida", es una cuenta bloqueada — distinción intencional)', async () => {
      jwt.verify.mockReturnValue({ sub: 'u1', businessId: 'b1' });
      User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(usuarioMock({ isActive: false })) });
      const next = jest.fn();

      await authenticate(mockReq('Bearer valido'), {}, next);

      const errorPasado = next.mock.calls[0][0];
      expect(errorPasado.statusCode).toBe(403);
      expect(errorPasado.code).toBeNull();
    });

    test('happy path: adjunta req.user/req.businessId y llama next() sin error', async () => {
      jwt.verify.mockReturnValue({ sub: 'u1', businessId: 'b1' });
      const usuario = usuarioMock();
      User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(usuario) });
      const next = jest.fn();
      const req = mockReq('Bearer valido');

      await authenticate(req, {}, next);

      expect(next).toHaveBeenCalledWith(); // sin argumentos = sin error
      expect(req.user).toBe(usuario);
      expect(req.businessId).toBe('b1');
    });
  });

  describe('authenticateUnverified()', () => {
    test('sin header Authorization: 401 + code', async () => {
      const next = jest.fn();
      await authenticateUnverified(mockReq(undefined), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE }));
    });

    test('usuario no encontrado o inactivo: 401 + code', async () => {
      jwt.verify.mockReturnValue({ sub: 'u1', businessId: 'b1' });
      User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
      const next = jest.fn();

      await authenticateUnverified(mockReq('Bearer valido'), {}, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: AUTH_SESSION_INVALID_CODE }));
    });

    test('happy path: no exige isEmailVerified, llama next() sin error', async () => {
      jwt.verify.mockReturnValue({ sub: 'u1', businessId: 'b1' });
      const usuario = usuarioMock({ isEmailVerified: false });
      User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(usuario) });
      const next = jest.fn();

      await authenticateUnverified(mockReq('Bearer valido'), {}, next);

      expect(next).toHaveBeenCalledWith();
    });
  });
});
