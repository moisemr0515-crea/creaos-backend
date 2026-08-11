const rateLimit = require('express-rate-limit');

/**
 * Rate limit global para todas las rutas de la API.
 * 100 requests por 15 minutos por IP.
 */
const rateLimitGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.',
  },
});

/**
 * Rate limit estricto para login.
 * 5 intentos por IP cada 15 minutos.
 * Bloquea ataques de fuerza bruta.
 */
const rateLimitLogin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // No contar logins exitosos
  message: {
    success: false,
    message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.',
  },
});

/**
 * Rate limit para forgot-password.
 * 3 solicitudes por IP cada hora (previene spam de emails).
 */
const rateLimitForgotPassword = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiadas solicitudes de recuperación. Intenta de nuevo en 1 hora.',
  },
});

/**
 * Rate limit para registro.
 * 5 registros por IP cada hora.
 */
const rateLimitRegister = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados registros desde esta IP. Intenta de nuevo en 1 hora.',
  },
});

/**
 * Rate limit para POST /missions/regenerate (llama a GPT-4o, cuesta dinero).
 * 5 regeneraciones por NEGOCIO cada hora — a diferencia de los limiters de
 * arriba (por IP), este se scopea por `req.businessId` porque el objetivo es
 * evitar abuso de la API de OpenAI por negocio, sin importar cuántos
 * usuarios distintos del mismo negocio lo disparen. Requiere que
 * `authenticate` + `injectTenant` ya hayan corrido antes (para tener
 * req.businessId disponible), igual que los demás middlewares de esta ruta.
 */
const rateLimitMissionRegenerate = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.businessId?.toString() || req.ip,
  message: {
    success: false,
    message: 'Demasiadas regeneraciones de Misión del Día. Intenta de nuevo más tarde (máximo 5 por hora).',
  },
});

module.exports = {
  rateLimitGeneral,
  rateLimitLogin,
  rateLimitForgotPassword,
  rateLimitRegister,
  rateLimitMissionRegenerate,
};
