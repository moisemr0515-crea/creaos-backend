const logger = require('../utils/logger');
const { NODE_ENV } = require('../config/env');

/**
 * Clase de error personalizado con statusCode HTTP.
 * Úsala en servicios/controladores: throw new AppError('msg', 404)
 */
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // Distingue errores esperados de bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Middleware global de manejo de errores.
 * Debe ser el ÚLTIMO middleware registrado en app.js.
 */
const errorHandler = (err, req, res, next) => {
  let { statusCode = 500, message } = err;

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

  // JWT expirado o inválido
  if (err.name === 'JsonWebTokenError') {
    message = 'Token inválido';
    statusCode = 401;
  }

  if (err.name === 'TokenExpiredError') {
    message = 'Token expirado';
    statusCode = 401;
  }

  // ─── Respuesta ──────────────────────────────────────────────────────────────
  res.status(statusCode).json({
    success: false,
    message,
    // Solo mostrar stack en desarrollo
    ...(NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = { AppError, errorHandler };
