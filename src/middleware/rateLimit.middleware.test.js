// Test real (Jest) de rateLimit.middleware.js — agregado junto con el fix
// del incidente real de producción del 06/sep/2026 (ver
// docs/implementation/known-issues.md): rateLimitGeneral pasó de ser por IP
// a ser por usuario autenticado, con IP como fallback para tráfico anónimo.
//
// Solo se testea claveRateLimitGeneral() (lógica pura de la clave) — armar
// 100 requests reales contra el rate limiter completo para probar el resto
// del comportamiento de express-rate-limit no aporta nada, esa librería ya
// tiene sus propios tests. Mismo patrón que auth.middleware.test.js: jwt
// mockeado entero, JWT_SECRET fijo.
jest.mock('jsonwebtoken');
jest.mock('../config/env', () => ({ JWT_SECRET: 'secreto-de-prueba' }));

const jwt = require('jsonwebtoken');
const { claveRateLimitGeneral } = require('./rateLimit.middleware');

function mockReq({ authHeader, ip = '1.2.3.4' } = {}) {
  return { headers: { authorization: authHeader }, ip };
}

describe('rateLimit.middleware#claveRateLimitGeneral()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('token válido (firma OK, sin vencer): clave "user:<sub>", NO la IP', () => {
    jwt.verify.mockReturnValue({ sub: 'u1' });

    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Bearer valido' }));

    expect(clave).toBe('user:u1');
    // ignoreExpiration:true a propósito — ver comentario del código real.
    expect(jwt.verify).toHaveBeenCalledWith('valido', 'secreto-de-prueba', { ignoreExpiration: true });
  });

  // Caso central del incidente real: el access token vence cada 15 min
  // (JWT_EXPIRES_IN) — en esa ventana, antes de que el refresh complete, las
  // requests siguen llegando con el token YA vencido. Sin esto, esas
  // requests caerían a IP justo en el momento de más tráfico de reintento.
  test('token con firma válida pero VENCIDO (TokenExpiredError bajo verify normal): igual devuelve "user:<sub>", no cae a IP', () => {
    // jwt.verify mockeado para simular el comportamiento real de
    // jsonwebtoken con ignoreExpiration:true — devuelve el payload igual,
    // sin tirar, a diferencia de una llamada sin esa opción.
    jwt.verify.mockImplementation((token, secret, opts) => {
      if (opts?.ignoreExpiration) return { sub: 'u1' };
      const err = new Error('jwt expired');
      err.name = 'TokenExpiredError';
      throw err;
    });

    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Bearer vencido' }));

    expect(clave).toBe('user:u1');
  });

  test('firma inválida (secret equivocado / token de otro origen): cae a IP', () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid signature'); });

    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Bearer falsificado', ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
  });

  test('token malformado (jwt.verify tira "jwt malformed"): cae a IP', () => {
    jwt.verify.mockImplementation(() => { throw new Error('jwt malformed'); });

    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Bearer no-es-un-jwt', ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
  });

  test('payload válido pero sin "sub" (caso borde, no debería pasar en la práctica): cae a IP', () => {
    jwt.verify.mockReturnValue({ businessId: 'b1' }); // sin sub

    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Bearer valido', ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
    expect(jwt.verify).toHaveBeenCalled();
  });

  test('sin header Authorization: cae a IP, ni siquiera llama a jwt.verify()', () => {
    const clave = claveRateLimitGeneral(mockReq({ authHeader: undefined, ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  test('header sin esquema "Bearer" (ej. "Token abc"): cae a IP', () => {
    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Token abc', ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  test('header "Bearer" sin token después (string vacío): cae a IP', () => {
    const clave = claveRateLimitGeneral(mockReq({ authHeader: 'Bearer ', ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  test('req.headers ausente del todo (no debería pasar con Express real, pero no debe explotar): cae a IP', () => {
    const clave = claveRateLimitGeneral({ ip: '9.9.9.9' });

    expect(clave).toBe('9.9.9.9');
  });
});
