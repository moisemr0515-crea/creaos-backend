const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const logger = require('../../../utils/logger');

/**
 * Dead Letter Queue — Blueprint §4.3. Acá caen los jobs de inbound/outbound
 * que agotaron sus reintentos. NO se reprocesan automáticamente — quedan
 * visibles para revisión manual (un endpoint de admin que los liste queda
 * explícitamente fuera de esta sub-fase, ver resumen de plan de 1.d).
 */

let queue = null;
function getDeadLetterQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.DEAD_LETTER, { connection: getQueueConnection() });
  return queue;
}

/**
 * @param {string} sourceQueue — nombre de la cola de origen (inbound/outbound)
 * @param {object} jobData — payload original del job que falló
 * @param {string} error — mensaje del último error
 */
async function moveToDeadLetter(sourceQueue, jobData, error) {
  await getDeadLetterQueue().add('dead-letter', { sourceQueue, jobData, error, failedAt: new Date().toISOString() });
  logger.error('[deadLetterQueue] job movido a dead letter', { sourceQueue, error });
}

module.exports = { getDeadLetterQueue, moveToDeadLetter };
