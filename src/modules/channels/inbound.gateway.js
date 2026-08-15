const GupshupProvider = require('./providers/gupshupProvider');
const channelResolver = require('./channel.resolver');
const tenantResolver = require('./tenant.resolver');
const InboundEvent = require('./inboundEvent.model');
const webhookService = require('../webhooks/webhook.service');
const { enqueueInbound } = require('./queues/inbound.queue');
const { WHATSAPP_QUEUE_PROCESSING_ENABLED } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Inbound Gateway — sub-fase 1.c. Reemplaza a
 * webhook.service.js#findGupshupConfig() como mecanismo de identificación
 * de tenant. Desde la sub-fase 1.d, lo que pasa DESPUÉS de resolver el
 * tenant y persistir el InboundEvent depende de un segundo flag,
 * independiente del que activa este archivo (ver más abajo, handleOne()):
 *
 *  - WHATSAPP_QUEUE_PROCESSING_ENABLED=false (default): idéntico a 1.c —
 *    llama a webhookService.processGupshupMessage() directo, síncrono.
 *  - WHATSAPP_QUEUE_PROCESSING_ENABLED=true: encola en BullMQ, un Worker en
 *    un servicio Railway separado lo procesa vía AgentRuntime.
 *
 * Solo se llama desde webhook.controller.js#gupshupWebhook() cuando
 * WHATSAPP_CHANNEL_CORE_ENABLED === true — con ESE flag en false (default),
 * este archivo no se ejecuta nunca.
 */

const gupshupProvider = new GupshupProvider();

/**
 * @param {object} rawPayload — body crudo del webhook de Gupshup
 */
async function handle(rawPayload) {
  const messages = gupshupProvider.normalizeInboundEvent(rawPayload);
  if (!messages.length) {
    logger.warn('[inboundGateway] payload sin mensajes de texto reconocibles', { body: rawPayload });
    return;
  }

  for (const msg of messages) {
    try {
      await handleOne(msg);
    } catch (err) {
      // Un mensaje del batch no debe tumbar el resto.
      logger.error('[inboundGateway] error procesando mensaje', { message: err.message, stack: err.stack, providerMessageId: msg.providerMessageId });
    }
  }
}

async function handleOne(msg) {
  const { phoneNumberId, wabaId } = msg.channelIdentifiers || {};

  const channel = await channelResolver.resolve({ provider: 'gupshup', phoneNumberId, wabaId });
  if (!channel) {
    logger.warn('[inboundGateway] ningún WhatsAppChannel matchea este payload', { phoneNumberId, wabaId });
    return;
  }

  let tenantId;
  try {
    tenantId = await tenantResolver.resolve(channel);
  } catch (err) {
    logger.error('[inboundGateway] tenant inválido, se descarta el mensaje', { channelId: channel._id, error: err.message });
    return;
  }

  let event;
  try {
    event = await InboundEvent.create({
      providerMessageId: msg.providerMessageId,
      provider: 'gupshup',
      channel: channel._id,
      tenantId,
      from: msg.from,
      text: msg.text,
      rawPayload: msg,
      status: 'received',
    });
  } catch (err) {
    if (err.code === 11000) {
      logger.info('[inboundGateway] mensaje duplicado (idempotencia), se ignora', { providerMessageId: msg.providerMessageId });
      return;
    }
    throw err;
  }

  event.status = 'processing';
  await event.save();

  if (WHATSAPP_QUEUE_PROCESSING_ENABLED) {
    // Sub-fase 1.d: se encola, no se procesa acá. El InboundEvent queda en
    // 'processing' hasta que inbound.worker.js (servicio Railway separado)
    // lo marque 'processed'/'failed'.
    try {
      await enqueueInbound(event._id);
    } catch (err) {
      // Si falla el enqueue (Redis/BullMQ no disponible), el evento no debe
      // quedar huérfano en 'processing' para siempre — se marca 'failed'
      // acá mismo, igual que la rama síncrona de abajo. Sin esto, un
      // reintento del mismo mensaje real de Gupshup se descartaría en
      // silencio por el índice único de providerMessageId (E11000) sin
      // haberse procesado nunca (hallazgo de code review).
      event.status = 'failed';
      event.error = err.message;
      await event.save();
      throw err;
    }
    return;
  }

  try {
    // Sin cambios respecto al flujo de 1.c — mismo Lead/Conversation/
    // ai.service.js/gupshup.client.js que usa processGupshupMessage() hoy.
    // Lo único distinto es que `tenantId` vino de ChannelResolver +
    // TenantResolver, no de findGupshupConfig().
    await webhookService.processGupshupMessage({ phone: msg.from, text: msg.text, name: msg.name }, tenantId);
    event.status = 'processed';
    event.processedAt = new Date();
    await event.save();
  } catch (err) {
    event.status = 'failed';
    event.error = err.message;
    await event.save();
    throw err;
  }
}

module.exports = { handle };
