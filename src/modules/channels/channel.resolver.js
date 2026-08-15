const channelRepository = require('./channel.repository');
const { getRedis } = require('../../config/redis');
const logger = require('../../utils/logger');

/**
 * ChannelResolver — reemplaza a webhook.service.js#findGupshupConfig()
 * (Blueprint §4.4). Resuelve el WhatsAppChannel real a partir de los
 * identificadores que manda el proveedor en el payload entrante, en vez de
 * "candidatos" contra un WebhookConfig genérico (ese era el bug del Caso 8).
 *
 * Cachea en Redis con TTL corto porque se llama en cada webhook entrante y
 * el dato cambia poco. La cache es *best-effort*: si Redis no está
 * conectado o falla, se cae directo a Mongo sin romper nada — no es una
 * dependencia dura de esta pieza.
 *
 * IMPORTANTE (sub-fase 1.b): esta función queda completa y probada acá,
 * pero todavía NO la llama el webhook real — eso es la sub-fase 1.c
 * (Inbound Gateway). Ver Implementation Blueprint §9.
 */

const CACHE_TTL_SECONDS = 60;
const cacheKey = (provider, kind, value) => `channel:${provider}:${kind}:${value}`;

async function tryGetCached(key) {
  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.warn('[ChannelResolver] cache Redis no disponible, se resuelve directo contra Mongo', { error: err.message });
    return null;
  }
}

async function trySetCached(key, channel) {
  try {
    const redis = getRedis();
    await redis.set(key, JSON.stringify(channel), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    // Cachear es una optimización, no un requisito — no es fatal.
  }
}

/**
 * @param {{provider: string, phoneNumberId?: string, wabaId?: string}} identifiers
 * @returns {Promise<import('./whatsappChannel.model')|null>}
 */
async function resolve({ provider, phoneNumberId, wabaId }) {
  // phoneNumberId es el identificador primario (índice único real del
  // modelo, {provider, phoneNumberId}). wabaId es un fallback deliberado —
  // el formato "legacy" de Gupshup no manda phoneNumberId (§4.3 del
  // Blueprint dice explícitamente "resolve(phoneNumberId/wabaId)"; corregido
  // en esta sub-fase, ver nota en el PR — en 1.b el fallback quedó sin usar).
  if (phoneNumberId) {
    const key = cacheKey(provider, 'pnid', phoneNumberId);
    const cached = await tryGetCached(key);
    if (cached) return cached;

    const channelDoc = await channelRepository.findByPhoneNumberId(provider, phoneNumberId);
    if (channelDoc) {
      const channel = channelDoc.toObject();
      await trySetCached(key, channel);
      return channel;
    }
  }

  if (wabaId) {
    const key = cacheKey(provider, 'waba', wabaId);
    const cached = await tryGetCached(key);
    if (cached) return cached;

    const channelDoc = await channelRepository.findByWabaId(provider, wabaId);
    if (channelDoc) {
      const channel = channelDoc.toObject();
      await trySetCached(key, channel);
      return channel;
    }
  }

  return null;
}

module.exports = { resolve };
