const logger = require('../utils/logger');
const { NODE_ENV } = require('../config/env');

/**
 * Marca explícita, distinta del `statusCode` HTTP, para un único caso: "este
 * 401 significa que la sesión del usuario ya no es válida" (auth.middleware.js
 * lo usa en sus 6 puntos de fallo). Nace del incidente del 04/sep/2026 —
 * apiFetch() del frontend (crea-os-ignite/src/lib/api/client.ts) trataba
 * CUALQUIER 401 como "sesión expirada" y deslogueaba al usuario, incluso
 * cuando el 401 lo generaba un proveedor externo (Gupshup) y nuestro backend
 * simplemente lo reenviaba tal cual. Ver docs/implementation/known-issues.md.
 *
 * Con esta marca, un 401 SIN este código nunca dispara el logout global del
 * frontend — es la señal estructural que resuelve la ambigüedad, en vez de
 * que el frontend tenga que adivinar por endpoint o por mensaje. El fix
 * complementario (partner.errors.js) además deja de usar 401 a secas para
 * errores de Gupshup, así que hoy esta marca solo la emite auth.middleware.js
 * — pero cualquier otro 401 futuro que NO la lleve queda protegido igual.
 */
const AUTH_SESSION_INVALID_CODE = 'AUTH_SESSION_INVALID';

/**
 * Clase de error personalizado con statusCode HTTP.
 * Úsala en servicios/controladores: throw new AppError('msg', 404)
 * `code` es opcional — hoy solo lo usa AUTH_SESSION_INVALID_CODE (arriba),
 * pero queda genérico por si aparece otro caso real que necesite la misma
 * distinción "el código HTTP no alcanza para que el caller decida qué hacer".
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true; // Distingue errores esperados de bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Middleware global de manejo de errores.
 * Debe ser el ÚLTIMO middleware registrado en app.js.
 */
const errorHandler = (err, req, res, next) => {
  let { statusCode = 500, message, code = null } = err;

  // Loguear el error con contexto de la request
  logger.error(`${req.method} ${req.originalUrl} → ${statusCode}: ${message}`, {
    stack: NODE_ENV === 'development' ? err.stack : undefined,
    userId: req.user?._id,
    businessId: req.businessId,
  });

  // ─── Errores específicos de Mongoose ────────────────────────────────────────

  // ID de MongoDB inválido (ej: /users/no-es-un-id)
  if (err.name === 'CastError') {
    message = `ID inválido: ${err.value}`;
    statusCode = 400;
  }

  // Clave duplicada (ej: email ya registrado)
  if (err.code === 11000) {
    const campo = Object.keys(err.keyValue)[0];
    message = `El ${campo} '${err.keyValue[campo]}' ya está registrado`;
    statusCode = 409;
  }

  // Validación de Mongoose fallida
  if (err.name === 'ValidationError') {
    const errores = Object.values(err.errors).map((e) => e.message);
    message = errores.join('. ');
    statusCode = 400;
  }

  // JWT expirado o inválido (jwt.verify() lanzado directo, sin pasar por
  // auth.middleware.js — hoy solo auth.service.js#refreshToken lo hace).
  // Mismo `code` que auth.middleware.js: para el frontend es exactamente el
  // mismo caso ("tu sesión ya no es válida").
  if (err.name === 'JsonWebTokenError') {
    message = 'Token inválido';
    statusCode = 401;
    code = AUTH_SESSION_INVALID_CODE;
  }

  if (err.name === 'TokenExpiredError') {
    message = 'Token expirado';
    statusCode = 401;
    code = AUTH_SESSION_INVALID_CODE;
  }

  // ─── Respuesta ──────────────────────────────────────────────────────────────
  res.status(statusCode).json({
    success: false,
    message,
    ...(code && { code }),
    // Solo mostrar stack en desarrollo
    ...(NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = { AppError, errorHandler, AUTH_SESSION_INVALID_CODE };
