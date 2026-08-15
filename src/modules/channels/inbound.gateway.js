const GupshupProvider = require('./providers/gupshupProvider');
const channelResolver = require('./channel.resolver');
const tenantResolver = require('./tenant.resolver');
const InboundEvent = require('./inboundEvent.model');
const webhookService = require('../webhooks/webhook.service');
const logger = require('../../utils/logger');

/**
 * Inbound Gateway — sub-fase 1.c. Reemplaza a
 * webhook.service.js#findGupshupConfig() como mecanismo de identificación
 * de tenant, pero NO reemplaza el pipeline de IA/envío — eso sigue siendo
 * webhookService.processGupshupMessage(), sin tocar (AgentRuntime/colas
 * quedan explícitamente para la sub-fase 1.d, ver Implementation Blueprint
 * §9). Este archivo es deliberadamente quirúrgico: solo cambia QUIÉN
 * resuelve el tenant, no CÓMO se genera/envía la respuesta.
 *
 * Solo se llama desde webhook.controller.js#gupshupWebhook() cuando
 * WHATSAPP_CHANNEL_CORE_ENABLED === true — con el flag en false (default),
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

  try {
    // Sin cambios respecto al flujo viejo a partir de acá — mismo Lead/
    // Conversation/ai.service.js/gupshup.client.js que usa processGupshupMessage()
    // hoy. Lo único distinto es que `tenantId` vino de ChannelResolver +
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
