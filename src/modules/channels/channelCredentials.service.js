// channelCredentials.service.js — Fase 2.0 del blueprint Meta+Gupshup
// Embedded Signup. Único punto de entrada para obtener las credenciales
// reales de envío de un canal — GupshupProvider lo llamará antes de cada
// operación de envío (eso es Fase 2.3, todavía sin implementar; este PR
// solo deja resolveCredentials() lista y probada).
const ChannelCredentials = require('./channelCredentials.model');
const { decrypt } = require('./channelCrypto');
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
 * @param {{ _id: import('mongoose').Types.ObjectId|string, credentialsReference?: string|null }} channel
 *   Documento WhatsAppChannel (o su forma plana, .toObject()).
 * @returns {Promise<{ appToken: string|null, apiKey: string }>}
 * @throws {AppError} si el canal DEDICATED no tiene ChannelCredentials, si
 *   no le queda ninguna apiKey activa, o si el descifrado falla (dato
 *   corrupto, o una subclave que ya no matchea).
 */
const resolveCredentials = async (channel) => {
  if (channel.credentialsReference?.startsWith('env:')) {
    // Compat canal PLATFORM. appToken:null a propósito — GUPSHUP_API_KEY
    // es lo único que gupshup.client.js usa hoy para mandar mensajes; el
    // rol exacto de appToken (¿solo para las Onboarding APIs, no para
    // envío?) todavía no está confirmado con Gupshup — ver blueprint §5.
    return { appToken: null, apiKey: GUPSHUP_API_KEY };
  }

  const creds = await ChannelCredentials.findOne({ channel: channel._id });
  if (!creds) {
    throw new AppError(`Canal ${channel._id} sin ChannelCredentials — ¿onboarding incompleto?`, 500);
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

module.exports = { resolveCredentials };
