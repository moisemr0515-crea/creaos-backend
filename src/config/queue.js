const IORedis = require('ioredis');
const { REDIS_URL } = require('./env');
const logger = require('../utils/logger');

/**
 * Conexión Redis DEDICADA para BullMQ — separada del cliente que ya usa
 * src/config/redis.js (usado hoy por ChannelResolver para cache).
 *
 * BullMQ exige `maxRetriesPerRequest: null` en la conexión para poder hacer
 * comandos bloqueantes (BRPOPLPUSH y similares) — el cliente compartido no
 * tiene esa opción, y cambiársela podría afectar a otros consumidores
 * (ej. el cache best-effort de ChannelResolver). Por eso esta conexión vive
 * aparte, aunque apunte al mismo REDIS_URL.
 */

let connection = null;

function getQueueConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    connection.on('error', (err) => logger.error('❌ Redis (colas) error:', err.message));
  }
  return connection;
}

async function disconnectQueueConnection() {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

// Nombres de cola centralizados — evita typos entre quien encola y quien consume.
const QUEUE_NAMES = {
  INBOUND: 'whatsapp-inbound',
  OUTBOUND: 'whatsapp-outbound',
  DEAD_LETTER: 'whatsapp-dead-letter',
};

// Config compartida de reintentos — 3 intentos con backoff exponencial
// arrancando en 2s (2s, 4s, 8s). Job que agota esto va a Dead Letter Queue.
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 60 * 60 * 24 * 7 }, // 7 días
  removeOnFail: false, // los fallidos se inspeccionan manualmente antes de limpiarlos
};

module.exports = { getQueueConnection, disconnectQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS };
