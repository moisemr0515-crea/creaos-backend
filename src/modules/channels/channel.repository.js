const WhatsAppChannel = require('./whatsappChannel.model');

/**
 * ChannelRepository — acceso a datos puro sobre WhatsAppChannel, sin lógica
 * de negocio (Blueprint §4.4). Primera vez que el repo introduce
 * explícitamente una capa "repository" separada del service — justificado
 * porque ChannelResolver necesita queries muy específicas y cacheables por
 * volumen de tráfico entrante.
 */

/** @returns {Promise<import('./whatsappChannel.model')|null>} */
function findByPhoneNumberId(provider, phoneNumberId) {
  if (!phoneNumberId) return null;
  return WhatsAppChannel.findOne({ provider, phoneNumberId });
}

/**
 * Fallback cuando el payload entrante no trae phoneNumberId (ej. formato
 * "legacy" de Gupshup, que solo manda `app`/appName, o un payload v3 con
 * metadata.phone_number_id ausente) — se intenta por wabaId en su lugar.
 * @returns {Promise<import('./whatsappChannel.model')|null>}
 */
function findByWabaId(provider, wabaId) {
  if (!wabaId) return null;
  return WhatsAppChannel.findOne({ provider, wabaId });
}

function findByTenant(tenantId) {
  return WhatsAppChannel.find({ tenantId });
}

function findById(channelId) {
  return WhatsAppChannel.findById(channelId);
}

function create(data) {
  return WhatsAppChannel.create(data);
}

function updateStatus(channelId, status) {
  return WhatsAppChannel.findByIdAndUpdate(channelId, { status }, { new: true });
}

module.exports = { findByPhoneNumberId, findByWabaId, findByTenant, findById, create, updateStatus };
