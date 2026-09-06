// Test real (Jest) de rateLimit.middleware.js — agregado junto con el fix
// del incidente real de producción del 06/sep/2026 (ver
// docs/implementation/known-issues.md): rateLimitGeneral pasó de ser por IP
// a ser por usuario autenticado, con IP como fallback para tráfico anónimo;
// más tarde, en el mismo incidente, se agregó logueo explícito de bloqueos
// (crearHandlerBloqueo) porque un 429 de rateLimitGeneral resultó ser
// estructuralmente invisible en los logs normales de request.
//
// Solo se testea la lógica pura (claves + el handler de bloqueo) — armar
// 100 requests reales contra el rate limiter completo para probar el resto
// del comportamiento de express-rate-limit no aporta nada, esa librería ya
// tiene sus propios tests. Mismo patrón que auth.middleware.test.js: jwt
// mockeado entero, JWT_SECRET fijo.
jest.mock('jsonwebtoken');
jest.mock('../config/env', () => ({ JWT_SECRET: 'secreto-de-prueba' }));

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { claveRateLimitGeneral, claveRateLimitLogin, crearHandlerBloqueo } = require('./rateLimit.middleware');

function mockReq({ authHeader, ip = '1.2.3.4', body } = {}) {
  return { headers: { authorization: authHeader }, ip, body };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
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

describe('rateLimit.middleware#claveRateLimitLogin()', () => {
  test('con email en el body: lo normaliza (trim + lowercase), NO usa la IP', () => {
    const clave = claveRateLimitLogin(mockReq({ body: { email: '  Nutriva.Corp@Gmail.com  ' }, ip: '9.9.9.9' }));

    expect(clave).toBe('nutriva.corp@gmail.com');
  });

  test('sin email en el body (malformado/vacío): cae a IP', () => {
    const clave = claveRateLimitLogin(mockReq({ body: {}, ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
  });

  test('email no es un string (body raro): cae a IP, no explota', () => {
    const clave = claveRateLimitLogin(mockReq({ body: { email: 12345 }, ip: '9.9.9.9' }));

    expect(clave).toBe('9.9.9.9');
  });

  test('req.body ausente del todo: cae a IP, no explota', () => {
    const clave = claveRateLimitLogin({ ip: '9.9.9.9' });

    expect(clave).toBe('9.9.9.9');
  });
});

// 06/sep/2026 (docs/implementation/known-issues.md): un 429 de
// rateLimitGeneral es invisible en los logs normales de request (corre
// ANTES del middleware que loguea, y al bloquear responde sin llamar a
// next()) — crearHandlerBloqueo() reemplaza el manejo default de
// express-rate-limit (que solo hace res.status().send(message), sin
// loguear nada) para que un bloqueo quede registrado explícitamente,
// identificando cuál limiter fue y contra qué clave.
describe('rateLimit.middleware#crearHandlerBloqueo()', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logger.warn.mockRestore();
  });

  test('loguea con el nombre del limiter, la clave calculada, ip, method y path — y responde igual que el handler default de express-rate-limit', () => {
    const obtenerClave = jest.fn().mockReturnValue('user:u1');
    const handler = crearHandlerBloqueo('rateLimitGeneral', obtenerClave);
    const req = { ip: '9.9.9.9', method: 'GET', originalUrl: '/api/v1/leads' };
    const res = mockRes();
    const next = jest.fn();
    const options = { statusCode: 429, message: { success: false, message: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.' } };

    handler(req, res, next, options);

    expect(obtenerClave).toHaveBeenCalledWith(req);
    expect(logger.warn).toHaveBeenCalledWith(
      '[rateLimit] rateLimitGeneral bloqueó una request',
      { clave: 'user:u1', ip: '9.9.9.9', method: 'GET', path: '/api/v1/leads' }
    );
    // Mismo comportamiento que el handler default de express-rate-limit
    // (res.status(statusCode).send(message)) — acá con .json() en vez de
    // .send(), mismo resultado para un objeto plano.
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(options.message);
    expect(next).not.toHaveBeenCalled(); // bloqueado de verdad, no deja pasar
  });

  test('distingue el nombre del limiter en el log (rateLimitLogin vs rateLimitGeneral)', () => {
    const handler = crearHandlerBloqueo('rateLimitLogin', () => 'nutrivacorpsac@gmail.com');
    const req = { ip: '9.9.9.9', method: 'POST', originalUrl: '/api/v1/auth/login' };
    const options = { statusCode: 429, message: { success: false, message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' } };

    handler(req, mockRes(), jest.fn(), options);

    expect(logger.warn).toHaveBeenCalledWith(
      '[rateLimit] rateLimitLogin bloqueó una request',
      expect.objectContaining({ clave: 'nutrivacorpsac@gmail.com' })
    );
  });
});
