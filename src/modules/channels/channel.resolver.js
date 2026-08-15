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
const cacheKey = (provider, phoneNumberId) => `channel:${provider}:${phoneNumberId}`;

/**
 * @param {{provider: string, phoneNumberId: string, wabaId?: string}} identifiers
 * @returns {Promise<import('./whatsappChannel.model')|null>}
 */
async function resolve({ provider, phoneNumberId, wabaId }) {
  if (!phoneNumberId) return null; // wabaId solo no alcanza hoy — el índice único real es {provider, phoneNumberId}

  const key = cacheKey(provider, phoneNumberId);

  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    // Redis no conectado o falló — no es fatal, se sigue a Mongo.
    logger.warn('[ChannelResolver] cache Redis no disponible, se resuelve directo contra Mongo', { error: err.message });
  }

  const channelDoc = await channelRepository.findByPhoneNumberId(provider, phoneNumberId);
  if (!channelDoc) return null;

  // Se devuelve siempre un objeto plano (no un documento Mongoose) — tanto
  // en el camino de cache-hit como de cache-miss, para que quien consuma
  // ChannelResolver.resolve() reciba siempre la misma forma, sin depender
  // de si vino de Redis o de Mongo. Quien necesite el documento Mongoose
  // real (ej. para llamar .save()) debe volver a buscarlo por _id.
  const channel = channelDoc.toObject();

  try {
    const redis = getRedis();
    await redis.set(key, JSON.stringify(channel), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    // Mismo criterio: cachear es una optimización, no un requisito.
  }

  return channel;
}

module.exports = { resolve };
