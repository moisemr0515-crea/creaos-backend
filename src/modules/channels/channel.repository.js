const WhatsAppChannel = require('./whatsappChannel.model');
const logger = require('../../utils/logger');

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

/**
 * Fallback para el formato "legacy" de Gupshup, que no manda phoneNumberId
 * ni wabaId en absoluto — solo `app` (el nombre de la app configurada en
 * Gupshup, ej. "CREAOS"). Mismo campo que ya usa
 * webhook.service.js#findGupshupConfig() para resolver este mismo formato
 * hoy en el camino viejo — acá se busca contra
 * WhatsAppChannel.providerAccountId, que ya se puebla con ese mismo valor.
 *
 * providerAccountId NO tiene índice único en el schema (a diferencia de
 * phoneNumberId, único por Meta/Gupshup, y wabaId, único por Meta) — el
 * nombre de una app de Gupshup no está garantizado como único a nivel de
 * base de datos. Con múltiples tenants (Fase 2, Embedded Signup), dos
 * negocios podrían terminar con nombres de app iguales o parecidos. Un
 * findOne() normal ahí devolvería el primer match que encuentre Mongo —
 * silenciosamente el canal EQUIVOCADO, enrutando un mensaje de un tenant
 * al CRM de otro. Viola aislamiento estructural por tenant (Principio 1
 * del Plan Maestro) y es peor que no resolver nada — por eso `find()` en
 * vez de `findOne()`: con 2+ matches, no se elige ninguno al azar, se
 * loguea la ambigüedad como error y se devuelve null (mismo "no
 * resoluble, se descarta" que ya existe para el resto de los casos sin
 * match en channel.resolver.js).
 *
 * @returns {Promise<import('./whatsappChannel.model')|null>}
 */
async function findByProviderAccountId(provider, providerAccountId) {
  if (!providerAccountId) return null;

  const matches = await WhatsAppChannel.find({ provider, providerAccountId });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  logger.error('[channelRepository] providerAccountId ambiguo, no se pudo resolver el canal', {
    provider,
    providerAccountId,
    matches: matches.length,
  });
  return null;
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

module.exports = { findByPhoneNumberId, findByWabaId, findByProviderAccountId, findByTenant, findById, create, updateStatus };
