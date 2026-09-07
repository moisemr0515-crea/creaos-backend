// Cliente delgado de la API de mensajería PARTNER de Gupshup
// (partner.gupshup.io) — PR1 del diseño de migración de outbound
// (docs/implementation/known-issues.md, 07/sep/2026). Hermano de
// gupshup.client.js (Legacy/self-serve, api.gupshup.io), NO un reemplazo —
// ese archivo queda intacto y sigue siendo el camino de PLATFORM.
//
// Confirmado con una prueba real aislada (07/sep/2026, canal "Negocio
// Prueba 2/3", appId 4f81131f-3b56-4bf5-808f-4e05176d0315): POST a este
// endpoint con el Partner App Access Token ya existente (el mismo que
// resolveCredentials() ya descifra para canales DEDICATED, sin necesidad de
// ninguna credencial nueva) devolvió 200 + message ID real, y el mensaje
// llegó físicamente al WhatsApp de destino.
//
// Mismo criterio que gupshup.client.js: sin dependencias hacia modelos de
// Mongo ni hacia ai.service.js/webhook.service.js — quien llama (
// gupshupProvider.js) resuelve channel/credenciales y pasa acá solo los
// valores ya resueltos.
const logger = require('../../utils/logger');

const PARTNER_API_BASE_URL = 'https://partner.gupshup.io';

/**
 * Envía un mensaje de texto por WhatsApp vía la API de mensajería Partner
 * de Gupshup (v3, shape estilo WhatsApp Cloud API — distinto del form-
 * urlencoded que usa gupshup.client.js#sendWhatsAppMessage()).
 *
 * Auth: header `Authorization` con el Partner App Access Token — NO
 * `apikey` (ese header es exclusivo de la familia Legacy/self-serve, ver
 * gupshup.client.js). Es el MISMO valor que ya devuelve
 * channelCredentials.service.js#resolveCredentials() para un canal
 * DEDICATED — confirmado en vivo, no hace falta pedir ni guardar nada
 * nuevo (docs/implementation/known-issues.md).
 *
 * @param {string} to - número de destino, sin "+" (mismo formato que ya usa gupshup.client.js)
 * @param {string} message - texto libre
 * @param {{ apiKey: string, appId: string }} credentials - `apiKey` es el
 *   Partner App Access Token (no el `apikey` self-serve); `appId` es el GUID
 *   de la app en Gupshup (`WhatsAppChannel.providerAppId`), va en la URL.
 * @returns {Promise<object>} JSON crudo de Gupshup (`{ messages: [{id}], ... }`)
 * @throws {Error} si Gupshup responde con un status distinto de 2xx — mismo
 *   criterio que gupshup.client.js (Error simple, no AppError): quien llama
 *   (gupshupProvider.js) ya propaga esto tal cual hacia arriba, y
 *   ai.service.js#sendAgentMessage()/webhook.service.js#processGupshupMessage()
 *   ya lo capturan igual que un error de Legacy, sin ningún cambio ahí.
 */
async function sendTextMessage(to, message, { apiKey, appId } = {}) {
  logger.info('[GupshupPartnerClient] enviando mensaje de texto via Partner API', {
    to,
    appId,
    hasApiKey: Boolean(apiKey),
  });

  const response = await fetch(`${PARTNER_API_BASE_URL}/partner/app/${appId}/v3/message`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: message },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[GupshupPartnerClient] Partner API respondió error', { status: response.status, body: errText, appId });
    throw new Error(`Gupshup Partner API error: ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[GupshupPartnerClient] mensaje enviado via Partner API exitosamente', { to, appId, gupshupResponse: json });
  return json;
}

module.exports = { sendTextMessage };
