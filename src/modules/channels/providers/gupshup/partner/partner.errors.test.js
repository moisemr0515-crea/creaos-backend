// Test real (Jest, commiteado) de partner.errors.js — PR-02 del blueprint
// CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md.
const { GupshupHttpError } = require('../gupshup.http.client');
const { mapPartnerError } = require('./partner.errors');

function httpError(statusCode, body, status = 'client_error') {
  return new GupshupHttpError(`Gupshup Partner API respondió ${statusCode}`, { status, statusCode, body, requestId: 'gsp_test' });
}

describe('partner.errors#mapPartnerError()', () => {
  test('400 -> AppError 400, propaga el mensaje real de Gupshup si viene', () => {
    const err = mapPartnerError(httpError(400, { message: 'Invalid characters used in app name' }), 'crear app "x"');
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/Invalid characters used in app name/);
    expect(err.message).toMatch(/crear app "x"/);
  });

  test('400 sin mensaje de Gupshup: usa un fallback genérico', () => {
    const err = mapPartnerError(httpError(400, null), 'contexto');
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/parámetros inválidos/);
  });

  test('401 -> AppError 502, NUNCA 401 (ver comentario en partner.errors.js — evita el falso "sesión expirada" en el frontend)', () => {
    const err = mapPartnerError(httpError(401, { message: 'Authentication Failed' }), 'login de partner');
    expect(err.statusCode).toBe(502);
    expect(err.statusCode).not.toBe(401);
    expect(err.message).toMatch(/autenticación fallida/i);
  });

  test('403 -> AppError 403', () => {
    const err = mapPartnerError(httpError(403, null), 'contexto');
    expect(err.statusCode).toBe(403);
  });

  test('409 -> AppError 409, menciona "Bot Already Exists"', () => {
    const err = mapPartnerError(httpError(409, { message: 'Bot Already Exists' }), 'crear app "CREAOS-tenant-1"');
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/Bot Already Exists/);
    expect(err.message).toMatch(/único/);
  });

  test('429 -> AppError 429, menciona el rate limit documentado', () => {
    const err = mapPartnerError(httpError(429, { message: 'Too Many Requests' }), 'contexto');
    expect(err.statusCode).toBe(429);
    expect(err.message).toMatch(/10 requests\/60s/);
  });

  test('500 -> AppError 502 (la falla es de Gupshup, no de CREA OS)', () => {
    const err = mapPartnerError(httpError(500, { message: 'Internal Server Error' }, 'server_error'), 'contexto');
    expect(err.statusCode).toBe(502);
  });

  test('network_error -> AppError 504', () => {
    const err = new GupshupHttpError('fallo de red', { status: 'network_error', requestId: 'gsp_test' });
    const mapped = mapPartnerError(err, 'contexto');
    expect(mapped.statusCode).toBe(504);
  });

  test('status code no documentado -> AppError 502 genérico, sin explotar', () => {
    const err = mapPartnerError(httpError(418, { message: 'teapot' }, 'client_error'), 'contexto');
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/inesperado/);
  });

  test('usa un contexto default si no se pasa ninguno', () => {
    const err = mapPartnerError(httpError(400, null));
    expect(err.message).toMatch(/operación de Gupshup Partner API/);
  });
});
