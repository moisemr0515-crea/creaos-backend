// partnerRateLimit.js — cuota GLOBAL de solicitudes al Partner API de Gupshup
// (partner.gupshup.io), compartida entre la API y el Worker vía Redis.
//
// Incidente de Nutriva (14/oct/2026): el Partner API permite 10 solicitudes por
// 60 s EN TOTAL (partner.errors.js, 429). El barrido automático de conciliación
// corre en otro proceso (el Worker) y compite por esa cuota con el onboarding
// interactivo de la API; sin un contador compartido, ninguno de los dos puede
// garantizar que no la excede.
//
// Diseño:
//  - Ventana deslizante en un ZSET de Redis, evaluada en UN solo script Lua (atómico
//    entre procesos; el reloj es el de Redis, no el de cada servidor). Más estricta
//    que una ventana fija, que permite el doble de ráfaga en el cambio de ventana.
//  - Margen de seguridad: tope global 8 de las 10 documentadas.
//  - Prioridades: el onboarding interactivo (default) puede usar hasta 8; el trabajo
//    en segundo plano (barrido) solo hasta 5, así siempre quedan 3 para la API.
//  - Interactivo: espera acotada (INTERACTIVE_MAX_WAIT_MS) a que se libere un cupo y
//    luego falla con 429; si Redis no responde NO se bloquea el flujo (fail-open: es
//    el comportamiento previo a este contador).
//  - Segundo plano: nunca espera y es FAIL-CLOSED — sin Redis o sin cupo no sale
//    ninguna solicitud; el barrido reprograma el intento.
//  - Solo cuenta lo que va al host del Partner API; la mensajería (api.gupshup.io)
//    no pasa por acá.
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { getRedis } = require('../../../../config/redis');
const logger = require('../../../../utils/logger');
const { AppError } = require('../../../../middleware/error.middleware');

const REDIS_KEY = 'partner:gupshup:ratelimit';
const WINDOW_MS = 60 * 1000;
const DOCUMENTED_LIMIT = 10;
const GLOBAL_LIMIT = 8;
const BACKGROUND_LIMIT = 5;
const INTERACTIVE_MAX_WAIT_MS = 10 * 1000;
const MIN_WAIT_MS = 50;
// Tope de espera por cada consulta a Redis: con Redis caído o reconectando, un
// comando puede quedar en la cola offline del cliente. Pasado este tiempo se trata
// como Redis no disponible (fondo: falla cerrado; interactivo: fail-open), así
// ninguna solicitud se cuelga esperando la reconexión. Un comando que igual llegue
// a ejecutarse después solo cuenta de más (lado seguro).
const COMMAND_TIMEOUT_MS = 2 * 1000;

const PRIORITY = Object.freeze({ INTERACTIVE: 'interactive', BACKGROUND: 'background' });

// Atómico: purga lo vencido, cuenta y, solo si hay cupo, registra la solicitud.
// Si no hay cupo devuelve en cuántos ms se libera el que hace falta (el N-ésimo
// más antiguo, con N = exceso sobre el tope de ESTA prioridad).
// KEYS[1]=clave; ARGV: 1=ventana ms, 2=tope, 3=miembro único.
const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= cap then
  local idx = count - cap
  local entry = redis.call('ZRANGE', KEYS[1], idx, idx, 'WITHSCORES')
  local retry = window
  if entry[2] then retry = tonumber(entry[2]) + window - now end
  if retry < 0 then retry = 0 end
  return {0, count, retry}
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window + 1000)
return {1, count + 1, 0}
`;

class PartnerLocalRateLimitError extends AppError {
  constructor(retryAfterMs) {
    super('Cupo local de solicitudes al Partner API de Gupshup agotado — se reintenta más tarde', 429, 'PARTNER_LOCAL_RATE_LIMIT');
    this.retryAfterMs = retryAfterMs;
  }
}

class PartnerLimiterUnavailableError extends AppError {
  constructor(cause) {
    super('No se puede verificar el cupo de solicitudes al Partner API de Gupshup (Redis no disponible) — no se envía la solicitud', 503, 'PARTNER_LIMITER_UNAVAILABLE');
    this.cause = cause;
  }
}

const storage = new AsyncLocalStorage();

/** Ejecuta `fn` (y todo lo async que dispare) con la prioridad indicada. */
function runWithPartnerPriority(priority, fn) {
  return storage.run({ priority }, fn);
}

function currentPriority() {
  return storage.getStore()?.priority || PRIORITY.INTERACTIVE;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tryAcquire(limit) {
  let timer;
  const vencido = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis no respondió en ${COMMAND_TIMEOUT_MS} ms`)), COMMAND_TIMEOUT_MS);
  });
  let res;
  try {
    // getRedis() dentro del try: si el cliente no existe, el error entra al mismo plan B.
    res = await Promise.race([
      getRedis().eval(ACQUIRE_SCRIPT, 1, REDIS_KEY, WINDOW_MS, limit, crypto.randomUUID()),
      vencido,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { allowed: Number(res[0]) === 1, count: Number(res[1]), retryAfterMs: Number(res[2]) };
}

/**
 * Reserva UN cupo para una solicitud al Partner API. Se llama antes de CADA intento
 * HTTP (los reintentos del cliente también consumen cupo).
 *
 * @param {{ priority?: 'interactive'|'background' }} [opts] default: la del contexto
 *   (runWithPartnerPriority) o 'interactive'.
 * @throws {PartnerLocalRateLimitError} 429 sin cupo (interactivo: tras esperar el máximo).
 * @throws {PartnerLimiterUnavailableError} 503 solo en segundo plano si Redis falla.
 */
async function acquirePartnerSlot({ priority = currentPriority() } = {}) {
  const background = priority === PRIORITY.BACKGROUND;
  const limit = background ? BACKGROUND_LIMIT : GLOBAL_LIMIT;
  const deadline = Date.now() + (background ? 0 : INTERACTIVE_MAX_WAIT_MS);

  for (;;) {
    let result;
    try {
      result = await tryAcquire(limit);
    } catch (err) {
      if (background) throw new PartnerLimiterUnavailableError(err);
      logger.warn('[partnerRateLimit] Redis no disponible — se omite el contador global (flujo interactivo, comportamiento previo)', { error: err.message });
      return;
    }

    if (result.allowed) return;

    const espera = Math.max(result.retryAfterMs, MIN_WAIT_MS);
    if (Date.now() + espera > deadline) throw new PartnerLocalRateLimitError(result.retryAfterMs);
    await sleep(espera);
  }
}

module.exports = {
  acquirePartnerSlot,
  runWithPartnerPriority,
  currentPriority,
  PartnerLocalRateLimitError,
  PartnerLimiterUnavailableError,
  PRIORITY,
  REDIS_KEY,
  WINDOW_MS,
  DOCUMENTED_LIMIT,
  GLOBAL_LIMIT,
  BACKGROUND_LIMIT,
  INTERACTIVE_MAX_WAIT_MS,
  COMMAND_TIMEOUT_MS,
  ACQUIRE_SCRIPT,
};
