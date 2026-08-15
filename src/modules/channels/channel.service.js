const { AppError } = require('../../middleware/error.middleware');
const channelRepository = require('./channel.repository');
const GupshupProvider = require('./providers/gupshupProvider');

/**
 * ChannelService — fachada pública del módulo channels/ (Blueprint §4.4).
 * Es la única puerta de entrada: nadie fuera de channels/ debe importar
 * GupshupProvider ni gupshup.client.js directamente (principio "no acoplar
 * el Core a Gupshup", §5 del Blueprint).
 *
 * v1 (sub-fase 1.b): solo `provider: 'gupshup'` existe, así que el mapeo
 * provider→implementación es trivial hoy. Cuando exista un segundo
 * provider, este es el único lugar que cambia (un factory/switch simple).
 */

function getProviderFor(channel) {
  if (channel.provider === 'gupshup') return new GupshupProvider();
  throw new AppError(`Provider "${channel.provider}" sin implementación registrada`, 500);
}

/**
 * @param {string} channelId
 * @param {string} to
 * @param {string} text
 */
async function sendMessage(channelId, to, text) {
  const channel = await channelRepository.findById(channelId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }

  const provider = getProviderFor(channel);
  return provider.sendMessage(channel, to, text);
}

/**
 * Estado operativo de un canal — Fase 1.1 (Provider Abstraction). Mismo
 * patrón de resolución que sendMessage(): recibe el ID, no el documento,
 * para mantener a ChannelService como la única puerta de entrada.
 * @param {string} channelId
 */
async function getChannelStatus(channelId) {
  const channel = await channelRepository.findById(channelId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }

  const provider = getProviderFor(channel);
  return provider.getChannelStatus(channel);
}

/**
 * @param {string} tenantId
 * @returns {Promise<Array>} canales activos del tenant
 */
async function getChannelForTenant(tenantId) {
  const channels = await channelRepository.findByTenant(tenantId);
  return channels.find((c) => c.status === 'active') || null;
}

function listChannels(tenantId) {
  return channelRepository.findByTenant(tenantId);
}

module.exports = { sendMessage, getChannelStatus, getChannelForTenant, listChannels };
