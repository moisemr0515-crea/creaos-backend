const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } = require('../../../config/queue');

/**
 * Cola de mensajes entrantes — consumida por inbound.worker.js (servicio
 * Railway separado, sub-fase 1.d). Solo se usa cuando
 * WHATSAPP_QUEUE_PROCESSING_ENABLED=true (ver inbound.gateway.js).
 */

let queue = null;
function getInboundQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.INBOUND, { connection: getQueueConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return queue;
}

/**
 * @param {string} inboundEventId — _id del InboundEvent ya persistido
 */
async function enqueueInbound(inboundEventId) {
  const jobId = String(inboundEventId);
  const queue = getInboundQueue();
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed') await existing.retry();
    return existing;
  }
  return queue.add('process-inbound', { inboundEventId: jobId }, { jobId });
}

module.exports = { getInboundQueue, enqueueInbound };
