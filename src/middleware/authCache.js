const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Cache de Redis para usuario+rol (authenticate()) y negocio (injectTenant())
 * — ver diagnóstico de lentitud percibida (17/sep/2026,
 * docs/post-hardening-diagnostico/). Toda request autenticada hacía como
 * mínimo 3 round-trips secuenciales a Mongo (User+populate(role),
 * Business) antes de llegar al controller real — medido en producción,
 * ~600-1000ms por request solo en ese costo fijo, sin importar cuán
 * simple fuera el endpoint.
 *
 * TTL corto (8s) a propósito: es suficiente para eliminar el costo
 * repetido dentro de una misma "carga de pantalla" (varios requests casi
 * simultáneos), sin volverse una fuente de inconsistencia real — y para
 * los 2 casos donde SÍ importa que la revocación sea instantánea
 * (usuario suspendido/cambio de rol, negocio suspendido), se invalida el
 * cache de forma activa en el momento exacto de la escritura (ver
 * user.service.js#actualizarUsuario/desactivarUsuario y
 * admin.controller.js#suspendUser/activateUser/changeUserRole/
 * suspendBusiness/activateBusiness) — el TTL queda como red de
 * seguridad, no como el único mecanismo de invalidación.
 *
 * Best-effort, mismo patrón que channel.resolver.js: si Redis no está
 * disponible, se cae directo a Mongo sin romper nada — no es una
 * dependencia dura de autenticación ni de aislamiento multi-tenant.
 */

const TTL_SEGUNDOS = 8;

const claveUsuario = (userId) => `authcache:user:${userId}`;
const claveNegocio = (businessId) => `authcache:business:${businessId}`;

async function leerCache(clave) {
  try {
    const redis = getRedis();
    const cached = await redis.get(clave);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.warn('[authCache] Redis no disponible para lectura, se resuelve directo contra Mongo', { clave, error: err.message });
    return null;
  }
}

async function escribirCache(clave, valor) {
  try {
    const redis = getRedis();
    // JSON.stringify() sobre un documento de Mongoose usa su toJSON()
    // interno (ObjectId → string, etc.) — no hace falta un .toObject()
    // explícito, y así funciona igual con un objeto plano (tests).
    await redis.set(clave, JSON.stringify(valor), 'EX', TTL_SEGUNDOS);
  } catch (err) {
    logger.warn('[authCache] Redis no disponible para escritura, se sigue sin cachear', { clave, error: err.message });
  }
}

async function invalidarCache(clave) {
  try {
    const redis = getRedis();
    await redis.del(clave);
  } catch (err) {
    // No fatal: el peor caso es que la revocación tarde hasta TTL_SEGUNDOS
    // en reflejarse (el mismo comportamiento que si no hubiera
    // invalidación activa), no un fallo de la operación que la disparó.
    logger.warn('[authCache] no se pudo invalidar cache (Redis no disponible) — revocación cae al TTL', { clave, error: err.message });
  }
}

const obtenerUsuarioCacheado = (userId) => leerCache(claveUsuario(userId));
const guardarUsuarioCacheado = (userId, usuario) => escribirCache(claveUsuario(userId), usuario);
const invalidarUsuarioCacheado = (userId) => invalidarCache(claveUsuario(userId));

const obtenerNegocioCacheado = (businessId) => leerCache(claveNegocio(businessId));
const guardarNegocioCacheado = (businessId, negocio) => escribirCache(claveNegocio(businessId), negocio);
const invalidarNegocioCacheado = (businessId) => invalidarCache(claveNegocio(businessId));

module.exports = {
  TTL_SEGUNDOS,
  obtenerUsuarioCacheado,
  guardarUsuarioCacheado,
  invalidarUsuarioCacheado,
  obtenerNegocioCacheado,
  guardarNegocioCacheado,
  invalidarNegocioCacheado,
};
