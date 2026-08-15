const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { moveToDeadLetter } = require('../queues/deadLetter.queue');
const OutboundEvent = require('../outboundEvent.model');
const channelService = require('../channel.service');
const logger = require('../../../utils/logger');

/**
 * outbound.worker.js — sub-fase 1.d. Consume whatsapp-outbound (encolado
 * por inbound.worker.js después de que AgentRuntime genera una respuesta).
 *
 * Llama a channelService.sendMessage() — la MISMA función síncrona
 * construida en 1.b, sin cambios de contrato. La cola no vive dentro de
 * channelService.sendMessage(); vive acá, un nivel arriba — así el envío
 * manual de un agente humano (ai.service.js#sendAgentMessage(), adaptado en
 * este mismo PR) puede seguir llamando a channelService.sendMessage()
 * directo y síncrono, sin pasar por ninguna cola.
 */

async function processOutboundJob(job) {
  const { outboundEventId } = job.data;
  const event = await OutboundEvent.findById(outboundEventId);
  if (!event) throw new Error(`OutboundEvent ${outboundEventId} no encontrado`);

  event.status = 'processing';
  await event.save();

  const result = await channelService.sendMessage(event.channel, event.to, event.text);

  event.status = 'sent';
  event.providerMessageId = result?.messageId || null;
  event.sentAt = new Date();
  await event.save();
}

function startOutboundWorker() {
  const worker = new Worker(
    QUEUE_NAMES.OUTBOUND,
    async (job) => {
      try {
        await processOutboundJob(job);
      } catch (err) {
        logger.error('[outboundWorker] error procesando job', { jobId: job.id, error: err.message, stack: err.stack });
        throw err;
      }
    },
    { connection: getQueueConnection(), concurrency: 5 }
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      await moveToDeadLetter(QUEUE_NAMES.OUTBOUND, job.data, err.message).catch((e) =>
        logger.error('[outboundWorker] no se pudo mover a dead letter', { error: e.message })
      );
      await OutboundEvent.findByIdAndUpdate(job.data.outboundEventId, { status: 'failed', error: err.message }).catch(() => {});
    }
  });

  return worker;
}

module.exports = { startOutboundWorker, processOutboundJob };
