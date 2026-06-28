const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { BCRYPT_SALT_ROUNDS } = require('../config/env');

/**
 * Hashea una contraseña con bcrypt (salt 12 por defecto).
 */
const hashPassword = async (password) => {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
};

/**
 * Compara una contraseña en texto plano con su hash.
 */
const comparePassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

/**
 * Genera un token aleatorio seguro (para emails, resets, etc.)
 * Devuelve el token en texto plano Y su hash SHA-256.
 * El texto plano se envía al usuario; el hash se guarda en BD.
 */
const generateToken = () => {
  const tokenPlano = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenPlano).digest('hex');
  return { tokenPlano, tokenHash };
};

/**
 * Hashea un token con SHA-256.
 * Úsalo para comparar el token recibido con el hash almacenado en BD.
 */
const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

module.exports = { hashPassword, comparePassword, generateToken, hashToken };
