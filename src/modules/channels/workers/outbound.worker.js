const { Worker, UnrecoverableError } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { moveToDeadLetter } = require('../queues/deadLetter.queue');
const OutboundEvent = require('../outboundEvent.model');
const Conversation = require('../../ai/conversation.model');
const channelService = require('../channel.service');
const subscriptionService = require('../../subscriptions/subscription.service');
const logger = require('../../../utils/logger');

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 409, 410, 422]);
const PRE_SEND_RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND']);
const AMBIGUOUS_TRANSPORT_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET']);

function extractStatusCode(err) {
  const direct = Number(err?.statusCode || err?.response?.status);
  if (Number.isInteger(direct)) return direct;
  const match = String(err?.message || '').match(/(?:error:|HTTP|respondió)\s*(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function classifyOutboundError(err) {
  if (err?.outboundRetryable === false) return { retryable: false, type: err.errorType || 'permanent' };
  const statusCode = extractStatusCode(err);
  if (statusCode === 429) return { retryable: true, type: 'rate_limit' };
  if (statusCode === 408) {
    if (err?.outboundSafeToRetry === true || err?.requestStarted === false) {
      return { retryable: true, type: 'pre_send_timeout' };
    }
    return { retryable: false, uncertain: true, type: 'ambiguous_provider_timeout' };
  }
  if (RETRYABLE_STATUS_CODES.has(statusCode) || statusCode >= 500) {
    return { retryable: true, type: 'provider_unavailable' };
  }
  if (PERMANENT_STATUS_CODES.has(statusCode)) {
    return { retryable: false, type: [401, 403].includes(statusCode) ? 'credentials_or_access' : 'invalid_request' };
  }
  const transportCode = err?.code || err?.cause?.code;
  if (PRE_SEND_RETRYABLE_ERROR_CODES.has(transportCode) || err?.requestStarted === false) {
    return { retryable: true, type: 'pre_send_network' };
  }
  if (err?.name === 'AbortError'
    || AMBIGUOUS_TRANSPORT_ERROR_CODES.has(transportCode)
    || /timeout|timed out|socket hang up/i.test(String(err?.message || ''))) {
    return { retryable: false, uncertain: true, type: 'ambiguous_provider_timeout' };
  }
  // Los errores desconocidos conservan los reintentos acotados de BullMQ;
  // después del máximo terminan en DLQ, nunca en un loop infinito.
  return { retryable: true, type: 'unexpected' };
}

function permanentError(message, errorType) {
  const err = new Error(message);
  err.outboundRetryable = false;
  err.errorType = errorType;
  return err;
}

function extractProviderMessageId(result) {
  return result?.messageId || result?.messages?.[0]?.id || result?.id || null;
}

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
  const attempt = (job.attemptsMade || 0) + 1;

  // Reclamo atómico. `processing` se admite para que BullMQ pueda recuperar
  // un job stalled después de una caída del proceso; `sent` jamás vuelve a
  // ser reclamado, por lo que un replay posterior no reenvía el mensaje.
  const event = await OutboundEvent.findOneAndUpdate(
    { _id: outboundEventId, status: { $in: ['pending', 'queued', 'retryable_failed', 'processing'] } },
    {
      $set: { status: 'processing', lastAttemptAt: new Date(), error: null, errorType: null },
      $inc: { attemptCount: 1 },
    },
    { new: true }
  );
  if (!event) {
    const interrupted = await OutboundEvent.findOneAndUpdate(
      { _id: outboundEventId, status: 'sending' },
      {
        status: 'delivery_uncertain',
        error: 'El worker se interrumpió durante la llamada al proveedor; no se reenvía automáticamente para evitar duplicados',
        errorType: 'ambiguous_delivery',
        terminalAt: new Date(),
      },
      { new: true }
    );
    if (interrupted) {
      logger.error('[outboundWorker] entrega ambigua tras interrupción; requiere conciliación', {
        outboundEventId: String(interrupted._id),
        tenantId: String(interrupted.tenantId),
        channelId: String(interrupted.channel),
        attempt,
        errorType: 'ambiguous_delivery',
        finalState: 'delivery_uncertain',
      });
      return;
    }
    logger.info('[outboundWorker] OutboundEvent terminal o ya resuelto, no-op idempotente', { outboundEventId, attempt });
    return;
  }

  let providerAccepted = false;
  try {
    // Repregunta aiEnabled justo antes de mandar: la IA pudo generar esta
    // respuesta antes de que un agente humano tomara control.
    const conversation = await Conversation.findOne({ _id: event.conversation, business: event.tenantId }, 'aiEnabled whatsappChannel business');
    if (!conversation || String(conversation.whatsappChannel) !== String(event.channel)) {
      throw permanentError('Conversación fuera del tenant o canal original inconsistente', 'tenant_or_channel_mismatch');
    }
    if (!conversation.aiEnabled) {
      event.status = 'skipped';
      event.error = 'aiEnabled se apagó (agente humano tomó control) antes del envío';
      event.errorType = 'human_takeover';
      event.terminalAt = new Date();
      await event.save();
      logger.info('[outboundWorker] envío cancelado, agente humano tomó control', { outboundEventId, tenantId: String(event.tenantId), channelId: String(event.channel), attempt, finalState: 'skipped' });
      return;
    }

    const entitlement = await subscriptionService.getEntitlement(event.tenantId);
    if (!entitlement.limits.aiEnabled
      || !entitlement.limits.whatsappEnabled
      || !entitlement.limits.automationsEnabled) {
      event.status = 'skipped';
      event.error = 'Entitlement de IA/WhatsApp/automatizaciones no disponible al ejecutar el envío';
      event.errorType = 'entitlement';
      event.terminalAt = new Date();
      await event.save();
      logger.info('[outboundWorker] envío cancelado por entitlement', { outboundEventId, tenantId: String(event.tenantId), channelId: String(event.channel), attempt, finalState: 'skipped' });
      return;
    }

    event.status = 'sending';
    await event.save();
    const result = await channelService.sendMessage(event.channel, event.to, event.text, event.tenantId);
    providerAccepted = true;
    event.status = 'sent';
    event.providerMessageId = extractProviderMessageId(result);
    event.sentAt = new Date();
    event.terminalAt = event.sentAt;
    await event.save();
  } catch (err) {
    if (providerAccepted) {
      event.status = 'delivery_uncertain';
      event.error = 'El proveedor aceptó el mensaje, pero no se pudo persistir la confirmación local';
      event.errorType = 'provider_accepted_persistence_failed';
      event.terminalAt = new Date();
      await event.save();
      logger.error('[outboundWorker] aceptación externa con persistencia local incierta; no se reenvía', {
        outboundEventId: String(event._id),
        tenantId: String(event.tenantId),
        channelId: String(event.channel),
        provider: event.provider,
        attempt,
        timestamp: event.terminalAt.toISOString(),
        errorType: 'provider_accepted_persistence_failed',
        finalState: 'delivery_uncertain',
      });
      return;
    }
    const classification = classifyOutboundError(err);
    if (classification.uncertain) {
      event.status = 'delivery_uncertain';
      event.error = 'Timeout ambiguo después de iniciar el envío al proveedor';
      event.errorType = classification.type;
      event.terminalAt = new Date();
      await event.save();
      logger.error('[outboundWorker] timeout ambiguo; no se reenvía automáticamente', {
        outboundEventId: String(event._id),
        tenantId: String(event.tenantId),
        channelId: String(event.channel),
        provider: event.provider,
        attempt,
        timestamp: event.terminalAt.toISOString(),
        errorType: 'ambiguous_provider_timeout',
        finalState: 'delivery_uncertain',
      });
      return;
    }
    event.status = classification.retryable ? 'retryable_failed' : 'permanently_failed';
    event.error = err.message;
    event.errorType = classification.type;
    if (!classification.retryable) event.terminalAt = new Date();
    await event.save();

    logger[classification.retryable ? 'warn' : 'error']('[outboundWorker] intento outbound fallido', {
      outboundEventId: String(event._id),
      tenantId: String(event.tenantId),
      channelId: String(event.channel),
      attempt,
      errorType: classification.type,
      finalState: event.status,
    });

    if (classification.retryable) throw err;
    const unrecoverable = new UnrecoverableError(err.message);
    unrecoverable.outboundRetryable = false;
    unrecoverable.errorType = classification.type;
    throw unrecoverable;
  }
}

async function handleOutboundFailure(job, err) {
  if (!job) return;
  const permanent = err?.name === 'UnrecoverableError';
  const exhausted = job.attemptsMade >= (job.opts.attempts || 1);
  if (!permanent && !exhausted) return;

  const classification = classifyOutboundError(err);
  await moveToDeadLetter(QUEUE_NAMES.OUTBOUND, job.data, classification.type).catch((e) =>
    logger.error('[outboundWorker] no se pudo mover a dead letter', { errorType: 'dead_letter_unavailable' })
  );
  const terminalEvent = await OutboundEvent.findByIdAndUpdate(job.data.outboundEventId, {
    status: 'permanently_failed',
    error: err.message,
    errorType: classification.type,
    terminalAt: new Date(),
  }, { new: true }).catch(() => null);
  logger.error('[outboundWorker] outbound terminó sin más reintentos', {
    outboundEventId: String(job.data.outboundEventId),
    tenantId: terminalEvent ? String(terminalEvent.tenantId) : undefined,
    channelId: terminalEvent ? String(terminalEvent.channel) : undefined,
    attempt: job.attemptsMade,
    errorType: classification.type,
    finalState: 'permanently_failed',
  });
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

  worker.on('failed', handleOutboundFailure);

  return worker;
}

module.exports = { startOutboundWorker, processOutboundJob, classifyOutboundError, handleOutboundFailure };
