// Test real (Jest) de error.middleware.js — agregado junto con el fix del
// incidente del 04/sep/2026 (ver docs/implementation/known-issues.md): antes
// de este fix, la respuesta JSON de un error nunca llevaba ningún campo que
// distinguiera "tu sesión ya no es válida" de cualquier otro error mapeado a
// 401 — el frontend no tenía forma de diferenciarlos sin adivinar.
const { AppError, errorHandler, AUTH_SESSION_INVALID_CODE } = require('./error.middleware');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('error.middleware', () => {
  const req = { method: 'GET', originalUrl: '/x', user: null, businessId: null };
  const next = jest.fn();

  test('AUTH_SESSION_INVALID_CODE es un string estable — el frontend (crea-os-ignite) lo compara literal', () => {
    expect(AUTH_SESSION_INVALID_CODE).toBe('AUTH_SESSION_INVALID');
  });

  test('AppError sin `code`: la respuesta NO incluye el campo `code`', () => {
    const res = mockRes();
    errorHandler(new AppError('Gupshup Partner API: autenticación fallida', 502), req, res, next);

    expect(res.status).toHaveBeenCalledWith(502);
    const body = res.json.mock.calls[0][0];
    expect(body).not.toHaveProperty('code');
    expect(body.message).toMatch(/autenticación fallida/);
  });

  test('AppError con code=AUTH_SESSION_INVALID_CODE: la respuesta SÍ incluye `code`', () => {
    const res = mockRes();
    errorHandler(new AppError('Token de autenticación requerido', 401, AUTH_SESSION_INVALID_CODE), req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('AUTH_SESSION_INVALID');
  });

  test('JsonWebTokenError crudo (no envuelto en AppError): 401 + code AUTH_SESSION_INVALID_CODE', () => {
    const res = mockRes();
    const err = new Error('jwt malformed');
    err.name = 'JsonWebTokenError';
    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('AUTH_SESSION_INVALID');
    expect(body.message).toBe('Token inválido');
  });

  test('TokenExpiredError crudo: 401 + code AUTH_SESSION_INVALID_CODE', () => {
    const res = mockRes();
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    errorHandler(err, req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(401);
    expect(body.code).toBe('AUTH_SESSION_INVALID');
    expect(body.message).toBe('Token expirado');
  });

  test('un AppError 401 SIN code (ej. si algún caller futuro lo hiciera mal) no inventa un code — el frontend no debe tratarlo como sesión inválida', () => {
    const res = mockRes();
    errorHandler(new AppError('algo que no es auth pero por error usa 401', 401), req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(401);
    expect(body).not.toHaveProperty('code');
  });
});
