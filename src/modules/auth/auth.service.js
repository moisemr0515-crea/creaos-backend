const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const {
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN,
} = require('../../config/env');
const { ROLES } = require('../../config/constants');
const { getRedis } = require('../../config/redis');
const { AppError } = require('../../middleware/error.middleware');

const User = require('../users/user.model');
const Business = require('../businesses/business.model');
const Role = require('../roles/role.model');

const { hashPassword, comparePassword, generateToken } = require('../../utils/crypto');
const { enviarEmailVerificacion, enviarEmailResetPassword } = require('../../utils/email');

// Duración del refresh token en segundos para Redis
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 días

// ─── HELPERS DE TOKEN ─────────────────────────────────────────────────────────

/**
 * Genera accessToken JWT (15min) con datos del usuario.
 */
const generarAccessToken = (usuario) => {
  return jwt.sign(
    {
      sub: usuario._id.toString(),
      businessId: usuario.business.toString(),
      roleSlug: usuario.role?.slug || null,
      jti: uuidv4(),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

/**
 * Genera refreshToken JWT (7d) y lo guarda en Redis.
 * Clave: rt:{userId}:{jti} → '1' con TTL de 7 días.
 */
const generarRefreshToken = async (usuario) => {
  const jti = uuidv4();

  const token = jwt.sign(
    {
      sub: usuario._id.toString(),
      jti,
    },
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN }
  );

  // Guardar en Redis para validación rápida
  const redis = getRedis();
  await redis.setex(`rt:${usuario._id}:${jti}`, REFRESH_TTL_SECONDS, '1');

  return { token, jti };
};

/**
 * Elimina un refresh token de Redis (logout / rotación).
 */
const revocarRefreshToken = async (userId, jti) => {
  const redis = getRedis();
  await redis.del(`rt:${userId}:${jti}`);
};

/**
 * Elimina TODOS los refresh tokens de un usuario (logout global).
 */
const revocarTodosLosRefreshTokens = async (userId) => {
  const redis = getRedis();
  const keys = await redis.keys(`rt:${userId}:*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
};

// ─── SERVICIO DE REGISTRO ─────────────────────────────────────────────────────

/**
 * Registro completo: crea Business + User en una transacción MongoDB.
 * Asigna rol Owner y envía email de verificación.
 */
const registrar = async ({ name, email, password, businessName, phone }) => {
  // Verificar si el email ya existe antes de la transacción
  const emailExistente = await User.findOne({ email });
  if (emailExistente) {
    throw new AppError('Este email ya está registrado', 409);
  }

  // Obtener rol Owner del sistema
  const rolOwner = await Role.findOne({ slug: ROLES.OWNER, business: null });
  if (!rolOwner) {
    throw new AppError('Error de configuración: rol Owner no encontrado. Ejecuta npm run seed', 500);
  }

  const passwordHash = await hashPassword(password);
  const { tokenPlano: tokenVerificacion, tokenHash: tokenVerificacionHash } = generateToken();
  const expiracion = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas

  let negocio, usuario;

  // Intentar con transacción (Atlas/replica set); fallback a operaciones secuenciales (standalone)
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      [negocio] = await Business.create([{ name: businessName, createdBy: null }], { session });
      [usuario] = await User.create(
        [{ name, email, password: passwordHash, phone: phone || null, role: rolOwner._id, business: negocio._id, emailVerificationToken: tokenVerificacionHash, emailVerificationExpires: expiracion }],
        { session }
      );
      await Business.findByIdAndUpdate(negocio._id, { createdBy: usuario._id }, { session });
    });
  } catch (txError) {
    // MongoDB standalone no soporta transacciones — usar operaciones secuenciales
    if (txError.message?.includes('replica set') || txError.message?.includes('Transaction numbers') || txError.codeName === 'IllegalOperation') {
      negocio = await Business.create({ name: businessName, createdBy: null });
      usuario = await User.create({ name, email, password: passwordHash, phone: phone || null, role: rolOwner._id, business: negocio._id, emailVerificationToken: tokenVerificacionHash, emailVerificationExpires: expiracion });
      await Business.findByIdAndUpdate(negocio._id, { createdBy: usuario._id });
    } else {
      throw txError;
    }
  } finally {
    await session.endSession();
  }

  // Enviar email de verificación (no bloquea el registro si falla)
  await enviarEmailVerificacion({ email: usuario.email, nombre: usuario.name, token: tokenVerificacion })
    .catch(() => {});

  // Popular el rol antes de generar tokens
  await usuario.populate('role', 'slug permissions');

  // Generar tokens
  const accessToken = generarAccessToken(usuario);
  const { token: refreshToken } = await generarRefreshToken(usuario);

  return {
    accessToken,
    refreshToken,
    usuario: {
      _id: usuario._id,
      name: usuario.name,
      email: usuario.email,
      role: usuario.role.slug,
      business: negocio._id,
      isEmailVerified: usuario.isEmailVerified,
    },
  };
};

// ─── SERVICIO DE LOGIN ────────────────────────────────────────────────────────

/**
 * Autentica un usuario y genera nuevos tokens.
 */
const login = async ({ email, password }) => {
  // Incluir password en la query (por defecto está excluido)
  const usuario = await User.findOne({ email })
    .select('+password')
    .populate('role', 'slug permissions');

  if (!usuario) {
    // Mensaje genérico para no revelar si el email existe
    throw new AppError('Credenciales inválidas', 401);
  }

  if (!usuario.isActive) {
    throw new AppError('Tu cuenta ha sido desactivada. Contacta al administrador', 403);
  }

  // Verificar contraseña
  const passwordCorrecta = await comparePassword(password, usuario.password);
  if (!passwordCorrecta) {
    throw new AppError('Credenciales inválidas', 401);
  }

  // Verificar email confirmado
  if (!usuario.isEmailVerified) {
    throw new AppError(
      'Debes verificar tu email antes de iniciar sesión. Revisa tu bandeja de entrada.',
      403
    );
  }

  // Actualizar último login
  await User.findByIdAndUpdate(usuario._id, { lastLogin: new Date() });

  // Generar tokens
  const accessToken = generarAccessToken(usuario);
  const { token: refreshToken } = await generarRefreshToken(usuario);

  return {
    accessToken,
    refreshToken,
    usuario: {
      _id: usuario._id,
      name: usuario.name,
      email: usuario.email,
      role: usuario.role.slug,
      business: usuario.business,
      isEmailVerified: usuario.isEmailVerified,
    },
  };
};

// ─── SERVICIO DE LOGOUT ───────────────────────────────────────────────────────

/**
 * Invalida el refresh token en Redis.
 */
const logout = async ({ refreshToken }) => {
  let payload;
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
  } catch {
    // Si el token es inválido/expirado, consideramos que ya no es válido → OK
    return;
  }

  await revocarRefreshToken(payload.sub, payload.jti);
};

// ─── SERVICIO DE REFRESH ──────────────────────────────────────────────────────

/**
 * Valida el refresh token y genera un nuevo accessToken.
 * Implementa rotación de refresh tokens por seguridad.
 */
const refreshAccessToken = async ({ refreshToken }) => {
  // Verificar JWT
  let payload;
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
  } catch {
    throw new AppError('Refresh token inválido o expirado', 401);
  }

  const redis = getRedis();
  const clave = `rt:${payload.sub}:${payload.jti}`;

  // Verificar que el token siga activo en Redis
  const existe = await redis.get(clave);
  if (!existe) {
    throw new AppError('Refresh token inválido o ya fue utilizado', 401);
  }

  // Buscar usuario
  const usuario = await User.findById(payload.sub).populate('role', 'slug permissions');
  if (!usuario || !usuario.isActive) {
    throw new AppError('Usuario no encontrado o inactivo', 401);
  }

  // Revocar token anterior (rotación)
  await revocarRefreshToken(payload.sub, payload.jti);

  // Generar nuevos tokens
  const nuevoAccessToken = generarAccessToken(usuario);
  const { token: nuevoRefreshToken } = await generarRefreshToken(usuario);

  return { accessToken: nuevoAccessToken, refreshToken: nuevoRefreshToken };
};

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

/**
 * Genera token de reset y envía email.
 * Siempre devuelve 200 aunque el email no exista (seguridad).
 */
const forgotPassword = async ({ email }) => {
  const usuario = await User.findOne({ email, isActive: true });

  // No revelar si el email existe
  if (!usuario) return;

  const { tokenPlano, tokenHash } = generateToken();
  const expiracion = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

  await User.findByIdAndUpdate(usuario._id, {
    passwordResetToken: tokenHash,
    passwordResetExpires: expiracion,
  });

  await enviarEmailResetPassword({
    email: usuario.email,
    nombre: usuario.name,
    token: tokenPlano,
  });
};

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────

/**
 * Valida el token y actualiza la contraseña.
 */
const resetPassword = async ({ token, password }) => {
  const { hashToken } = require('../../utils/crypto');
  const tokenHash = hashToken(token);

  const usuario = await User.findOne({
    passwordResetToken: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select('+passwordResetToken +passwordResetExpires');

  if (!usuario) {
    throw new AppError('Token inválido o expirado', 400);
  }

  const passwordHash = await hashPassword(password);

  await User.findByIdAndUpdate(usuario._id, {
    password: passwordHash,
    passwordResetToken: undefined,
    passwordResetExpires: undefined,
  });

  // Revocar todos los refresh tokens activos (seguridad post-reset)
  await revocarTodosLosRefreshTokens(usuario._id.toString());
};

// ─── VERIFY EMAIL ─────────────────────────────────────────────────────────────

/**
 * Confirma la cuenta del usuario mediante el token enviado por email.
 */
const verifyEmail = async ({ token }) => {
  const { hashToken } = require('../../utils/crypto');
  const tokenHash = hashToken(token);

  const usuario = await User.findOne({
    emailVerificationToken: tokenHash,
    emailVerificationExpires: { $gt: new Date() },
  }).select('+emailVerificationToken +emailVerificationExpires');

  if (!usuario) {
    throw new AppError('Token de verificación inválido o expirado', 400);
  }

  await User.findByIdAndUpdate(usuario._id, {
    isEmailVerified: true,
    emailVerificationToken: undefined,
    emailVerificationExpires: undefined,
  });
};

module.exports = {
  registrar,
  login,
  logout,
  refreshAccessToken,
  forgotPassword,
  resetPassword,
  verifyEmail,
};
