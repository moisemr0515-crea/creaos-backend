// partner.auth.js — autenticación de servidor contra el Partner API de
// Gupshup. login() + cache del token en Redis con TTL menor al expiry real,
// para no loguear en cada operación (§11 del blueprint maestro).
//
// VERIFICADO 28 ago 2026 (docs/integrations/gupshup-partner-api-contract.md):
// la respuesta real de POST /partner/account/login NO trae ningún campo de
// expiry (ni "expiresIn" ni "tokenExpiry") — el "24h" está documentado solo
// en prosa. TOKEN_TTL_SECONDS de abajo es por eso una constante local
// nuestra (23h, para renovar 1h antes del vencimiento documentado), no un
// valor leído de la respuesta de Gupshup.
const httpClient = require('../gupshup.http.client');
const { GupshupHttpError } = httpClient;
const { mapPartnerError } = require('./partner.errors');
const { getRedis } = require('../../../../../config/redis');
const logger = require('../../../../../utils/logger');
const { AppError } = require('../../../../../middleware/error.middleware');
const {
  GUPSHUP_PARTNER_EMAIL, GUPSHUP_PARTNER_SECRET, GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED,
} = require('../../../../../config/env');

// Diagnóstico de elegibilidad (informe 57): registra ÚNICAMENTE estos cinco indicadores no secretos del socio,
// en la renovación natural del token. Nunca el JWT, credenciales ni la respuesta completa. Se apaga con
// GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED=false sin afectar la autenticación.
const INDICADORES_SOCIO = ['isTpp', 'onboardEnabled', 'enableAppOnboarding', 'enableWallet', 'billingType'];
const BILLING_TYPES_RECONOCIDOS = ['PREPAID', 'POSTPAID']; // lista cerrada: cualquier otro valor se registra como 'inesperado'
const NOMBRE_SEGURO = /^[A-Za-z_]{1,20}$/;

// La documentación los muestra en la raíz de la respuesta, pero no se asume: se busca en la raíz y, si no
// está, UN solo nivel dentro de objetos hijos (nunca más profundo, nunca en arreglos).
function localizarIndicador(raw, clave) {
  if (!raw || typeof raw !== 'object') return { valor: undefined, ubicacion: null };
  if (Object.prototype.hasOwnProperty.call(raw, clave)) return { valor: raw[clave], ubicacion: 'raiz' };
  for (const [contenedor, hijo] of Object.entries(raw)) {
    if (hijo && typeof hijo === 'object' && !Array.isArray(hijo) && Object.prototype.hasOwnProperty.call(hijo, clave)) {
      return { valor: hijo[clave], ubicacion: NOMBRE_SEGURO.test(contenedor) ? contenedor : 'otro' };
    }
  }
  return { valor: undefined, ubicacion: null };
}

// Solo salen valores de un conjunto cerrado (booleano, o un tipo de facturación reconocido). Todo lo demás
// se sustituye por una marca fija: jamás se copia un valor arbitrario.
function valorSeguro(clave, valor) {
  if (valor === undefined || valor === null) return 'ausente';
  if (clave === 'billingType') {
    const canonico = typeof valor === 'string' ? valor.toUpperCase() : null;
    return BILLING_TYPES_RECONOCIDOS.includes(canonico) ? canonico : 'inesperado';
  }
  return typeof valor === 'boolean' ? valor : 'inesperado';
}

function registrarIndicadoresSocio(raw) {
  try {
    if (!GUPSHUP_INDICADORES_SOCIO_LOG_ENABLED) return;
    const salida = {};
    const fueraDeLaRaiz = {};
    for (const clave of INDICADORES_SOCIO) {
      const { valor, ubicacion } = localizarIndicador(raw, clave);
      salida[clave] = valorSeguro(clave, valor);
      if (ubicacion && ubicacion !== 'raiz') fueraDeLaRaiz[clave] = ubicacion;
    }
    // Solo aparece si algún indicador NO vino en la raíz (para corregir la lectura); es el nombre del contenedor, no un dato.
    if (Object.keys(fueraDeLaRaiz).length) salida.ubicacionNoRaiz = fueraDeLaRaiz;
    logger.info('[partner.auth] indicadores del socio (solo 5 campos)', salida);
  } catch {
    // El registro de diagnóstico nunca debe afectar al inicio de sesión.
  }
}

const REDIS_KEY = 'partner:gupshup:auth';
const TOKEN_TTL_SECONDS = 23 * 60 * 60; // 23h — expiry real documentado: 24h

/**
 * POST /partner/account/login — sin auth previa (es el login en sí).
 * Rate limit documentado: 10 requests/60s (igual que el resto del Partner
 * API) — no se cachea acá el resultado, eso es responsabilidad de
 * getValidToken(); login() siempre pega contra Gupshup.
 *
 * @param {string} email
 * @param {string} secret - client secret del Partner Portal
 * @returns {Promise<{ token: string, raw: object }>} `raw` es la respuesta
 *   completa (incluye billingType, enableWallet, etc.) por si algún caller
 *   futuro lo necesita — hoy solo se usa `token`.
 * @throws {AppError} 401 (credenciales inválidas), 429 (rate limit), 502/504
 *   (Gupshup caído o sin responder).
 */
async function login(email, secret) {
  let response;
  try {
    response = await httpClient.request({
      method: 'POST',
      path: '/partner/account/login',
      form: { email, secret },
      idempotent: false, // login es un POST con efecto de auditoría del lado de Gupshup — no reintentar solo, el retry lo maneja quien llama si hace falta
    });
  } catch (err) {
    if (err instanceof GupshupHttpError) throw mapPartnerError(err, 'login de partner');
    throw err;
  }

  if (!response.body?.token) {
    throw new AppError('Gupshup Partner API: login sin "token" en la respuesta — respuesta inesperada del proveedor', 502);
  }

  return { token: response.body.token, raw: response.body };
}

/**
 * Token cacheado en Redis si es válido; si no (cache miss o Redis caído),
 * hace login() con las credenciales de servidor (env vars) y lo cachea para
 * la próxima llamada. Nunca deja el servicio bloqueado por un fallo de
 * Redis — cachear es una optimización, no un requisito (mismo criterio que
 * ChannelResolver, ver channel.resolver.js).
 *
 * @returns {Promise<string>}
 * @throws {AppError} 500 si faltan GUPSHUP_PARTNER_EMAIL/GUPSHUP_PARTNER_SECRET,
 *   o lo que tire login() si el login en sí falla.
 */
async function getValidToken() {
  try {
    const redis = getRedis();
    const cached = await redis.get(REDIS_KEY);
    if (cached) return cached;
  } catch (err) {
    logger.warn('[partner.auth] cache Redis no disponible, se hace login directo', { error: err.message });
  }

  if (!GUPSHUP_PARTNER_EMAIL || !GUPSHUP_PARTNER_SECRET) {
    throw new AppError('GUPSHUP_PARTNER_EMAIL/GUPSHUP_PARTNER_SECRET no configurados', 500);
  }

  const { token, raw } = await login(GUPSHUP_PARTNER_EMAIL, GUPSHUP_PARTNER_SECRET);
  registrarIndicadoresSocio(raw);

  try {
    const redis = getRedis();
    await redis.set(REDIS_KEY, token, 'EX', TOKEN_TTL_SECONDS);
  } catch (err) {
    // Con Redis caído, cada llamada futura vuelve a loguear — dentro del
    // rate limit real (10 req/60s) esto no es un problema salvo un fallo
    // prolongado de Redis, que ya se logueó arriba.
    logger.warn('[partner.auth] no se pudo cachear el token (Redis no disponible)', { error: err.message });
  }

  return token;
}

module.exports = { login, getValidToken, REDIS_KEY, TOKEN_TTL_SECONDS };
