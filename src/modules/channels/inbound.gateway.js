const GupshupProvider = require('./providers/gupshupProvider');
const channelResolver = require('./channel.resolver');
const tenantResolver = require('./tenant.resolver');
const InboundEvent = require('./inboundEvent.model');
const { enqueueInbound } = require('./queues/inbound.queue');
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
 * Fase 1.f (docs/implementation/known-issues.md): se llama sin condición
 * desde webhook.controller.js#gupshupWebhook() — se retiró el feature flag
 * WHATSAPP_CHANNEL_CORE_ENABLED (y el camino legacy que reemplazó) tras la
 * ventana de validación de 14+ días sin incidentes.
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

  const errors = [];
  for (const msg of messages) {
    try {
      await handleOne(msg);
    } catch (err) {
      logger.error('[inboundGateway] error procesando mensaje', { message: err.message, stack: err.stack, providerMessageId: msg.providerMessageId });
      errors.push(err);
    }
  }
  if (errors.length) throw errors[0];
}

async function handleOne(msg) {
  const { phoneNumberId, wabaId, appName } = msg.channelIdentifiers || {};

  // appName cubre el formato "legacy" de Gupshup (sin phoneNumberId ni
  // wabaId) — ver channel.resolver.js#resolve() y
  // channel.repository.js#findByProviderAccountId(). Antes de este fix,
  // un mensaje legacy siempre resolvía a channel:null acá (appName nunca
  // se pasaba), así que se perdía en el `if (!channel)` de abajo, en
  // silencio, para el 100% del tráfico en ese formato.
  const channel = await channelResolver.resolve({ provider: 'gupshup', phoneNumberId, wabaId, appName });
  if (!channel) {
    logger.warn('[inboundGateway] ningún WhatsAppChannel matchea este payload', { phoneNumberId, wabaId });
    throw new Error('No se pudo resolver un WhatsAppChannel para el mensaje entrante');
  }
  if (channel.status !== 'active') {
    throw new Error(`WhatsAppChannel ${channel._id} no está activo`);
  }

  let tenantId;
  try {
    tenantId = await tenantResolver.resolve(channel);
  } catch (err) {
    logger.error('[inboundGateway] tenant inválido, el mensaje no se acepta', { channelId: channel._id, error: err.message });
    throw err;
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
      mediaType: msg.mediaType || null,
      mediaSourceUrl: msg.mediaSourceUrl || null,
      rawPayload: msg,
      status: 'received',
    });
  } catch (err) {
    if (err.code === 11000) {
      const existing = await InboundEvent.findOne({ providerMessageId: msg.providerMessageId });
      if (existing && ['received', 'failed'].includes(existing.status)) {
        await enqueueInbound(existing._id);
      }
      logger.info('[inboundGateway] mensaje duplicado (idempotencia), no se persiste otra vez', { providerMessageId: msg.providerMessageId });
      return;
    }
    throw err;
  }

  try {
    await enqueueInbound(event._id);
  } catch (err) {
    event.status = 'failed';
    event.error = err.message;
    await event.save();
    throw err;
  }
}

module.exports = { handle };
