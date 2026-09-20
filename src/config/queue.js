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
  // Caso 7 del backlog — motor de automatizaciones, trigger por tiempo.
  // AUTOMATION_SWEEP: un job repetible que pregunta "qué leads cumplen una
  // condición de tiempo ahora" y encola AUTOMATION_EXECUTE por cada match
  // (mismo patrón Gateway→Queue→Worker que whatsapp-inbound/outbound, ver
  // automations/workers/automationSweep.worker.js).
  AUTOMATION_SWEEP: 'automation-sweep',
  AUTOMATION_EXECUTE: 'automation-execute',
  // Bloque 3 de la auditoría Business Brain (§45-50, 20/sep/2026) — RAG del
  // PDF. Chunking+embeddings+cutover corren fuera del request HTTP de
  // upload (pueden tardar varios segundos en un PDF grande).
  INDEX_BUSINESS_DOCUMENT: 'index-business-document',
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
