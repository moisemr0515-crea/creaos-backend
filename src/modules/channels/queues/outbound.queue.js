const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } = require('../../../config/queue');
const OutboundEvent = require('../outboundEvent.model');
const logger = require('../../../utils/logger');

const RECOVERABLE_OUTBOUND_STATUSES = ['pending', 'enqueue_failed', 'queued', 'retryable_failed'];

/**
 * Cola de mensajes salientes — consumida por outbound.worker.js. Se usa
 * exclusivamente para las respuestas automáticas de la IA generadas por
 * inbound.worker.js (vía AgentRuntime). El envío manual de un agente humano
 * (ai.service.js#sendAgentMessage()) NO pasa por acá — sigue siendo
 * síncrono vía channelService.sendMessage() directo (ver resumen de plan).
 */

let queue = null;
function getOutboundQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.OUTBOUND, { connection: getQueueConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return queue;
}

/**
 * @param {string} outboundEventId — _id del OutboundEvent ya persistido
 */
async function enqueueOutbound(outboundEventId) {
  const jobId = String(outboundEventId);
  const queue = getOutboundQueue();

  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') await existing.retry();
      if (state === 'completed') {
        await existing.remove();
        const replacement = await queue.add('process-outbound', { outboundEventId: jobId }, { jobId });
        await OutboundEvent.updateOne(
          { _id: outboundEventId, status: { $in: ['pending', 'enqueue_failed', 'retryable_failed'] } },
          { $set: { status: 'queued', error: null, errorType: null } }
        );
        return replacement;
      }
      await OutboundEvent.updateOne(
        { _id: outboundEventId, status: { $in: ['pending', 'enqueue_failed', 'retryable_failed'] } },
        { $set: { status: 'queued', error: null, errorType: null } }
      );
      return existing;
    }

    const job = await queue.add('process-outbound', { outboundEventId: jobId }, { jobId });
    await OutboundEvent.updateOne(
      { _id: outboundEventId, status: { $in: ['pending', 'enqueue_failed', 'retryable_failed'] } },
      { $set: { status: 'queued', error: null, errorType: null } }
    );
    return job;
  } catch (err) {
    await OutboundEvent.updateOne(
      { _id: outboundEventId, status: { $in: RECOVERABLE_OUTBOUND_STATUSES } },
      { $set: { status: 'enqueue_failed', error: err.message, errorType: 'queue_unavailable' } }
    ).catch(() => {});
    throw err;
  }
}

async function recoverPendingOutboundEvents({ limit = 500 } = {}) {
  const events = await OutboundEvent.find({ status: { $in: RECOVERABLE_OUTBOUND_STATUSES } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id tenantId channel status');

  let recovered = 0;
  for (const event of events) {
    try {
      await enqueueOutbound(event._id);
      recovered += 1;
    } catch (err) {
      logger.error('[outboundQueue] no se pudo recuperar evento', {
        outboundEventId: String(event._id),
        tenantId: String(event.tenantId),
        channelId: String(event.channel),
        errorType: 'queue_unavailable',
        finalState: 'enqueue_failed',
      });
    }
  }
  return recovered;
}

module.exports = {
  getOutboundQueue,
  enqueueOutbound,
  recoverPendingOutboundEvents,
  RECOVERABLE_OUTBOUND_STATUSES,
};
