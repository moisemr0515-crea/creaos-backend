const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { moveToDeadLetter } = require('../queues/deadLetter.queue');
const OutboundEvent = require('../outboundEvent.model');
const Conversation = require('../../ai/conversation.model');
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

  // Reclamo atómico (hallazgo de code review): solo transiciona
  // pending -> processing. Si el job ya fue reclamado por un intento
  // anterior (reintento tras un fallo posterior al envío real, o
  // reasignación por "stalled job" de BullMQ tras un crash/restart del
  // worker), esto devuelve null y no se reenvía nada — cierra el hueco de
  // envío duplicado por WhatsApp. findOneAndUpdate es atómico en Mongo, así
  // que dos ejecuciones concurrentes nunca pueden ganar la misma carrera.
  const event = await OutboundEvent.findOneAndUpdate(
    { _id: outboundEventId, status: 'pending' },
    { status: 'processing' },
    { new: true }
  );
  if (!event) {
    logger.info('[outboundWorker] OutboundEvent ya procesado/en proceso, se ignora (idempotencia)', { outboundEventId });
    return;
  }

  // Repregunta aiEnabled justo antes de mandar (hallazgo de code review): la
  // IA pudo haber generado esta respuesta antes de que un agente humano
  // tomara el control de la conversación (sendAgentMessage() apaga
  // aiEnabled) mientras el job esperaba en la cola — si eso pasó, no se
  // manda una respuesta de IA por encima del agente.
  const conversation = await Conversation.findById(event.conversation, 'aiEnabled');
  if (conversation && !conversation.aiEnabled) {
    event.status = 'skipped';
    event.error = 'aiEnabled se apagó (agente humano tomó control) antes del envío';
    await event.save();
    logger.info('[outboundWorker] envío cancelado, agente humano tomó control', { outboundEventId });
    return;
  }

  try {
    const result = await channelService.sendMessage(event.channel, event.to, event.text);
    event.status = 'sent';
    event.providerMessageId = result?.messageId || null;
    event.sentAt = new Date();
    await event.save();
  } catch (err) {
    // Mismo criterio que inbound.gateway.js: no dejar el evento huérfano en
    // 'processing' si el envío falla.
    event.status = 'failed';
    event.error = err.message;
    await event.save();
    throw err;
  }
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
