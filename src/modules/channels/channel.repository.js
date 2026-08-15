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

module.exports = { findByPhoneNumberId, findByTenant, findById, create, updateStatus };
