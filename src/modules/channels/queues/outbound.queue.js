const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } = require('../../../config/queue');

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
  return getOutboundQueue().add('process-outbound', { outboundEventId: String(outboundEventId) });
}

module.exports = { getOutboundQueue, enqueueOutbound };
