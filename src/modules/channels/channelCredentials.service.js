// channelCredentials.service.js — Fase 2.0 del blueprint Meta+Gupshup
// Embedded Signup. Único punto de entrada para obtener las credenciales
// reales de envío de un canal — GupshupProvider lo llamará antes de cada
// operación de envío (eso es Fase 2.3, todavía sin implementar; este PR
// solo deja resolveCredentials() lista y probada).
const ChannelCredentials = require('./channelCredentials.model');
const { decrypt, encrypt } = require('./channelCrypto');
const WhatsAppChannel = require('./whatsappChannel.model');
const Conversation = require('../ai/conversation.model');
const { AppError } = require('../../middleware/error.middleware');
const { GUPSHUP_API_KEY } = require('../../config/env');

/**
 * Resuelve las credenciales reales de un WhatsAppChannel para mandar
 * mensajes — de env vars si es el canal PLATFORM (compatibilidad, sin
 * migrar nada), o descifradas desde ChannelCredentials si es un canal
 * DEDICATED nuevo.
 *
 * Nunca devuelve null en silencio ante un fallo real — un canal `active`
 * que no puede resolver sus credenciales es un estado roto, tiene que
 * hacer ruido (tirar AppError), no comportarse como "todavía sin
 * configurar". `appToken: null` en el resultado es la única excepción
 * legítima, y solo para el canal PLATFORM (ver nota abajo) — no es un
 * fallo, es que ese campo no existe en el esquema viejo de env vars.
 *
 * @param {{ _id: import('mongoose').Types.ObjectId|string, connectionType: string }} channel
 *   Documento WhatsAppChannel (o su forma plana, .toObject()).
 * @returns {Promise<{ appToken: string|null, apiKey: string }>}
 * @throws {AppError} si el canal DEDICATED no tiene ChannelCredentials, si
 *   no le queda ninguna apiKey activa, o si el descifrado falla (dato
 *   corrupto, o una subclave que ya no matchea).
 */
const resolveCredentials = async (channel) => {
  // Fase 2.1 (blueprint fase-2.1-blueprint-final.md §3): el discriminador
  // PLATFORM vs. DEDICATED pasa a ser connectionType, no credentialsReference.
  // Antes se detectaba el canal PLATFORM por el prefijo 'env:' de
  // credentialsReference — pero ese campo ahora es un ObjectId ref real hacia
  // ChannelCredentials (whatsappChannel.model.js), así que ese string ya no
  // existe como valor posible. connectionType ya distinguía exactamente esto
  // sin ambigüedad, así que pasa a ser la única fuente de verdad de esta rama.
  if (channel.connectionType === 'PLATFORM') {
    // Compat canal PLATFORM. appToken:null a propósito — GUPSHUP_API_KEY
    // es lo único que gupshup.client.js usa hoy para mandar mensajes; el
    // rol exacto de appToken (¿solo para las Onboarding APIs, no para
    // envío?) todavía no está confirmado con Gupshup — ver blueprint §5.
    if (!GUPSHUP_API_KEY) throw new AppError('GUPSHUP_API_KEY no configurada para el canal PLATFORM', 500);
    return { appToken: null, apiKey: GUPSHUP_API_KEY };
  }

  const creds = await ChannelCredentials.findOne({ channel: channel._id, tenantId: channel.tenantId, provider: channel.provider });
  if (!creds) {
    throw new AppError(`Canal ${channel._id} sin ChannelCredentials — ¿onboarding incompleto?`, 500);
  }
  if (channel.credentialsReference && String(channel.credentialsReference) !== String(creds._id)) {
    throw new AppError(`Canal ${channel._id}: referencia de credenciales inconsistente`, 500);
  }

  // La más reciente activa (no revocada) por createdAt explícito — NO por
  // orden del array (no hay ninguna garantía real de que apiKeys[] quede
  // siempre en orden de inserción, ej. una migración futura podría
  // reescribirlo). Con varias activas a la vez (Gupshup lo permite), la
  // app usa la más nueva para mandar; las más viejas activas siguen
  // siendo válidas del lado de Gupshup hasta que se revoquen
  // explícitamente, pero no hace falta que esta función elija entre ellas.
  //
  // LIMITACIÓN CONOCIDA: revokedAt acá es el estado que CREA OS conoce,
  // no necesariamente el estado real en Gupshup en este instante. Si
  // alguien revoca una key directo desde el Partner Portal de Gupshup
  // (sin pasar por un endpoint de CREA OS — los 3 endpoints de
  // rotación/revocación son Fase 2.0-b, todavía sin implementar), este
  // documento NO se entera solo — sigue marcando esa key como activa
  // hasta que algo la actualice a mano, o hasta que se construya una
  // sincronización real contra Gupshup (depende de la pregunta abierta
  // del blueprint §5/09: si Gupshup expone el estado de sus keys vía API,
  // no solo por el Portal). Hoy esto no tiene consecuencia práctica —
  // ningún código todavía usa resolveCredentials() para mandar de verdad
  // (eso es Fase 2.3) — pero cuando lo use, un intento de envío con una
  // key marcada "activa" acá pero ya revocada en Gupshup va a fallar del
  // lado de Gupshup con un error de autenticación, no acá.
  const apiKeyActiva = [...creds.apiKeys]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((entry) => !entry.revokedAt);
  if (!apiKeyActiva) {
    throw new AppError(`Canal ${channel._id}: todas las apiKeys están revocadas`, 500);
  }

  try {
    return {
      appToken: creds.appToken?.current ? decrypt(creds.appToken.current, String(channel._id)) : null,
      apiKey: decrypt(apiKeyActiva.value, String(channel._id)),
    };
  } catch (err) {
    // authTag no matchea, keyVersion sin clave disponible, dato corrupto —
    // cualquiera de estos es grave, se propaga tal cual, nunca se traga.
    throw new AppError(`Canal ${channel._id}: credenciales ilegibles (${err.message})`, 500);
  }
};

async function loadScopedCredentials(channelId, tenantId) {
  const channel = await WhatsAppChannel.findOne({ _id: channelId, tenantId, businessId: tenantId });
  if (!channel) throw new AppError('Canal no encontrado', 404);
  if (channel.connectionType === 'PLATFORM') throw new AppError('Las credenciales PLATFORM se administran mediante variables de entorno', 409);
  const creds = await ChannelCredentials.findOne({ channel: channel._id, tenantId, provider: channel.provider });
  if (!creds) throw new AppError('Credenciales del canal no encontradas', 404);
  return { channel, creds };
}

async function rotateApiKey({ channelId, tenantId, apiKey, label }) {
  if (!apiKey || typeof apiKey !== 'string') throw new AppError('apiKey es requerida', 400);
  const { channel, creds } = await loadScopedCredentials(channelId, tenantId);
  creds.apiKeys.push({ value: encrypt(apiKey, String(channel._id)), label: label || null });
  await creds.save();
  if (channel.status !== 'active' && channel.status !== 'disconnected') {
    channel.status = 'active';
    await channel.save();
  }
  return { credentialId: creds.apiKeys[creds.apiKeys.length - 1]._id, activeKeys: creds.apiKeys.filter((key) => !key.revokedAt).length };
}

async function revokeApiKey({ channelId, tenantId, credentialId, actorId, reason }) {
  const { channel, creds } = await loadScopedCredentials(channelId, tenantId);
  const entry = creds.apiKeys.id(credentialId);
  if (!entry) throw new AppError('Credencial no encontrada', 404);
  if (!entry.revokedAt) {
    entry.revokedAt = new Date();
    entry.revokedBy = actorId;
    entry.revokedReason = reason || 'manual_revocation';
    await creds.save();
  }
  const activeKeys = creds.apiKeys.filter((key) => !key.revokedAt).length;
  if (activeKeys === 0) {
    channel.status = 'suspended';
    await channel.save();
  }
  return { credentialId: entry._id, activeKeys, channelStatus: channel.status };
}

async function revokeAllForChannel({ channelId, tenantId, actorId, reason = 'channel_disconnected' }) {
  const channel = await WhatsAppChannel.findOne({ _id: channelId, tenantId, businessId: tenantId });
  if (!channel) throw new AppError('Canal no encontrado', 404);
  if (channel.connectionType === 'PLATFORM') {
    channel.status = 'disconnected';
    await channel.save();
    await Conversation.updateMany({ business: tenantId, whatsappChannel: channel._id }, { $set: { whatsappChannelStatus: 'reassignment_required' } });
    return { channelId: channel._id, status: channel.status, activeKeys: null };
  }
  const { creds } = await loadScopedCredentials(channelId, tenantId);
  const now = new Date();
  for (const entry of creds.apiKeys) {
    if (!entry.revokedAt) {
      entry.revokedAt = now;
      entry.revokedBy = actorId;
      entry.revokedReason = reason;
    }
  }
  await creds.save();
  channel.status = 'disconnected';
  await channel.save();
  await Conversation.updateMany({ business: tenantId, whatsappChannel: channel._id }, { $set: { whatsappChannelStatus: 'reassignment_required' } });
  return { channelId: channel._id, status: channel.status, activeKeys: 0 };
}

module.exports = { resolveCredentials, rotateApiKey, revokeApiKey, revokeAllForChannel };
