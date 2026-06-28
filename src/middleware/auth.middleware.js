const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { AppError } = require('./error.middleware');
const User = require('../modules/users/user.model');

/**
 * Verifica el Bearer token JWT en el header Authorization.
 * Adjunta req.user con los datos del usuario autenticado.
 * Adjunta req.tokenPayload con el payload completo del JWT.
 */
const authenticate = async (req, res, next) => {
  try {
    // Extraer token del header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Token de autenticación requerido', 401);
    }

    const token = authHeader.split(' ')[1];

    // Verificar y decodificar
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        throw new AppError('El token ha expirado', 401);
      }
      throw new AppError('Token inválido', 401);
    }

    // Buscar usuario activo en BD
    const usuario = await User.findById(payload.sub).populate('role', 'slug permissions');

    if (!usuario) {
      throw new AppError('Usuario no encontrado', 401);
    }

    if (!usuario.isActive) {
      throw new AppError('Tu cuenta ha sido desactivada. Contacta al administrador', 403);
    }

    if (!usuario.isEmailVerified) {
      throw new AppError('Debes verificar tu email antes de continuar', 403);
    }

    // Adjuntar al request para uso en siguientes middlewares/controladores
    req.user = usuario;
    req.tokenPayload = payload;
    req.businessId = payload.businessId;

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Verifica el token JWT sin requerir email verificado.
 * Útil para rutas de re-envío de verificación.
 */
const authenticateUnverified = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Token de autenticación requerido', 401);
    }

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);

    const usuario = await User.findById(payload.sub).populate('role', 'slug permissions');

    if (!usuario || !usuario.isActive) {
      throw new AppError('Usuario no encontrado o inactivo', 401);
    }

    req.user = usuario;
    req.tokenPayload = payload;
    req.businessId = payload.businessId;

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { authenticate, authenticateUnverified };
