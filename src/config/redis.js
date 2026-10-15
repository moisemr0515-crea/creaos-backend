const Redis = require('ioredis');
const { REDIS_URL } = require('./env');
const logger = require('../utils/logger');

let redisClient = null;
let connecting = null; // promesa de la conexión en curso (single-flight de connectRedis)
let closedOnPurpose = false; // disconnectRedis() fue llamado: no hay que reanimar el cliente
let reviving = false;
let lastReviveAt = 0;
let hadOutage = false;
let lastErrorLogAt = 0;
let suppressedErrors = 0;

// Incidente de Nutriva (14/oct/2026) — validación con Redis real: antes, tras 10
// intentos fallidos (~5,5 s de caída) el cliente pasaba a estado 'end' y NO volvía a
// conectarse aunque Redis regresara, hasta reiniciar el proceso. Ahora:
//  - el cliente reintenta SIEMPRE, con espera creciente acotada (un solo temporizador
//    pendiente a la vez: no es un bucle apretado ni abre conexiones paralelas);
//  - los comandos que esperan una reconexión fallan rápido (MAX_RETRIES_PER_REQUEST)
//    en lugar de quedar colgados, así cada consumidor aplica su propio plan B.
const RETRY_STEP_MS = 100;
const RETRY_MAX_DELAY_MS = 1000;
const RETRY_JITTER_MS = 200;
const MAX_RETRIES_PER_REQUEST = 2;
const REVIVE_COOLDOWN_MS = 5000;
const ERROR_LOG_INTERVAL_MS = 30 * 1000;

/** Espera antes del reintento N. NUNCA devuelve null (null = abandonar la conexión). */
const retryStrategy = (times) => Math.min(times * RETRY_STEP_MS, RETRY_MAX_DELAY_MS) + Math.floor(Math.random() * RETRY_JITTER_MS);

// Una caída prolongada reintenta cada ~1 s; sin esto el log se llenaría de errores
// idénticos. Se registra el primero y luego un resumen cada ERROR_LOG_INTERVAL_MS.
const logRedisError = (err) => {
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) {
    suppressedErrors += 1;
    return;
  }
  lastErrorLogAt = now;
  logger.error('❌ Redis error:', err.message, suppressedErrors ? `(+${suppressedErrors} iguales omitidos)` : '');
  suppressedErrors = 0;
};

/**
 * Crea y conecta el cliente Redis.
 * Usa ioredis con reconexión automática permanente. Idempotente: llamadas
 * simultáneas o repetidas comparten UNA sola conexión.
 */
const connectRedis = async () => {
  if (redisClient && redisClient.status !== 'end') return redisClient;
  if (connecting) return connecting;

  closedOnPurpose = false;
  connecting = new Promise((resolve, reject) => {
    const client = new Redis(REDIS_URL, {
      retryStrategy,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
      lazyConnect: true,
      enableReadyCheck: true,
    });

    client.on('connect', () => {
      logger.info('✅ Redis conectado');
    });

    client.on('ready', () => {
      if (hadOutage) {
        hadOutage = false;
        logger.info('✅ Redis reconectado tras una interrupción');
      }
      redisClient = client;
      resolve(client);
    });

    client.on('error', logRedisError);

    client.on('close', () => {
      hadOutage = true;
      logger.warn('⚠️  Redis conexión cerrada');
    });

    // Conectar explícitamente
    client.connect().catch((err) => {
      // Falla del ARRANQUE: el proceso lo trata como fatal. Se cierra este cliente
      // para que no siga reintentando en segundo plano.
      client.disconnect();
      reject(err);
    });
  }).finally(() => {
    connecting = null;
  });

  return connecting;
};

/**
 * Red de seguridad: si el cliente quedó en 'end' sin que nadie lo cerrara a
 * propósito (ej. falla del conector), se reanima el MISMO cliente — nunca se crea
 * otro —, a lo sumo una vez cada REVIVE_COOLDOWN_MS y de a uno a la vez. Solo en
 * 'end': en 'reconnecting' llamar connect() abriría una conexión paralela.
 */
const reviveIfEnded = () => {
  if (!redisClient || closedOnPurpose || reviving || redisClient.status !== 'end') return;
  if (Date.now() - lastReviveAt < REVIVE_COOLDOWN_MS) return;
  reviving = true;
  lastReviveAt = Date.now();
  logger.warn('⚠️  Redis en estado "end" sin cierre intencional — reanimando el cliente');
  redisClient.connect()
    .catch((err) => logger.warn('⚠️  No se pudo reanimar Redis; se reintenta más tarde', { error: err.message }))
    .finally(() => { reviving = false; });
};

/**
 * Devuelve el cliente Redis activo.
 * Lanza error si no está conectado.
 */
const getRedis = () => {
  if (!redisClient) {
    throw new Error('Redis no está conectado. Llama connectRedis() primero.');
  }
  reviveIfEnded();
  return redisClient;
};

/**
 * Cierra la conexión Redis limpiamente.
 */
const disconnectRedis = async () => {
  if (redisClient) {
    closedOnPurpose = true;
    const client = redisClient;
    redisClient = null;
    try {
      await client.quit();
    } catch {
      client.disconnect(); // quit() falla si ya no hay conexión: se corta sin esperar
    }
    logger.info('Redis desconectado limpiamente');
  }
};

module.exports = { connectRedis, getRedis, disconnectRedis, retryStrategy };
