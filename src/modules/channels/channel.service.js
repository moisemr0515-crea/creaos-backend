const { AppError } = require('../../middleware/error.middleware');
const channelRepository = require('./channel.repository');
const GupshupProvider = require('./providers/gupshupProvider');
const logger = require('../../utils/logger');

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
 * Envía un mensaje de plantilla aprobada — a diferencia de sendMessage()
 * (texto libre), no requiere que la ventana de 24h esté abierta.
 * @param {string} channelId
 * @param {string} to
 * @param {{ id: string, params?: string[] }} template
 */
async function sendTemplate(channelId, to, template) {
  const channel = await channelRepository.findById(channelId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }

  const provider = getProviderFor(channel);
  return provider.sendTemplate(channel, to, template);
}

/**
 * Lista las plantillas aprobadas disponibles para un canal.
 * @param {string} channelId
 * @returns {Promise<Array>}
 */
async function listTemplates(channelId) {
  const channel = await channelRepository.findById(channelId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }

  const provider = getProviderFor(channel);
  return provider.listTemplates(channel);
}

/**
 * Envía un mensaje con media (imagen/video) — al igual que sendMessage()
 * (texto libre), SÍ requiere que la ventana de 24h esté abierta.
 * @param {string} channelId
 * @param {string} to
 * @param {{ url: string, type: 'image'|'video', caption?: string }} media
 */
async function sendMedia(channelId, to, media) {
  const channel = await channelRepository.findById(channelId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }

  const provider = getProviderFor(channel);
  return provider.sendMedia(channel, to, media);
}

/**
 * Descarga el binario de un media ENTRANTE (imagen/video que un lead mandó)
 * a partir de la URL temporal que trae el payload del webhook.
 * @param {string} channelId
 * @param {string} mediaUrl
 * @returns {Promise<{ buffer: Buffer, contentType: string|null }>}
 */
async function downloadMedia(channelId, mediaUrl) {
  const channel = await channelRepository.findById(channelId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }

  const provider = getProviderFor(channel);
  return provider.downloadMedia(channel, mediaUrl);
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

/**
 * PR-10a — resuelve el canal de ENVÍO correcto para un mensaje saliente
 * dentro de una conversación puntual, en vez de "el primer canal activo del
 * tenant" a secas (getChannelForTenant(), arriba). Con 2+ canales activos
 * para el mismo tenant, ese comportamiento era ambiguo — no garantiza que
 * la respuesta salga por el MISMO canal por el que entró el mensaje del
 * lead (ver Conversation.whatsappChannel, conversation.model.js).
 *
 * Con 0 o 1 canal activo (100% de la base hoy), el resultado es IDÉNTICO al
 * de getChannelForTenant() en todos los casos — este cambio es
 * preventivo, no corrige nada que se haya observado roto todavía.
 *
 * @param {import('../ai/conversation.model')|null|undefined} conversation
 * @param {import('mongoose').Types.ObjectId|string} tenantId
 * @returns {Promise<import('./whatsappChannel.model')|null>}
 */
async function getChannelForConversation(conversation, tenantId) {
  if (conversation?.whatsappChannel) {
    const channel = await channelRepository.findById(conversation.whatsappChannel);
    // Mismo criterio de "activo" que getChannelForTenant() — findById() no
    // filtra por status, así que se chequea acá explícito. Si el canal de
    // origen de esta conversación quedó suspendido/con error/desconectado
    // después de recibir el mensaje, no tiene sentido intentar mandar por
    // él — cae al fallback en vez de fallar (o peor, intentar mandar por un
    // canal que sabemos que no está operativo).
    if (channel && channel.status === 'active') return channel;

    // Referencia rota (el canal no existe — caso hoy imposible, nada borra
    // un WhatsAppChannel) o encontrado pero no activo — cualquiera de los 2
    // cae al fallback en vez de fallar, y se deja constancia para poder
    // detectarlo.
    logger.warn('[channelService] conversation.whatsappChannel no resolvió a un WhatsAppChannel activo, cae al fallback de "primer canal activo del tenant"', {
      conversationId: conversation._id ? String(conversation._id) : null,
      whatsappChannel: String(conversation.whatsappChannel),
      encontrado: Boolean(channel),
      statusEncontrado: channel?.status ?? null,
    });
  }

  // Sin whatsappChannel poblado (conversación previa a este campo, o
  // iniciada sin un canal real de origen — ej. arrancada a mano desde el
  // CRM) — mismo comportamiento que existía antes de PR-10a, sin cambios.
  return getChannelForTenant(tenantId);
}

function listChannels(tenantId) {
  return channelRepository.findByTenant(tenantId);
}

module.exports = {
  sendMessage, sendTemplate, listTemplates, sendMedia, downloadMedia, getChannelStatus,
  getChannelForTenant, getChannelForConversation, listChannels,
};
