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

const TIPOS_MEDIA_SOPORTADOS = ['image', 'video', 'document'];

/**
 * Envía un mensaje con media (imagen/video/documento) por WhatsApp vía la
 * misma API de mensajería Partner (v3) que sendTextMessage() — mismo
 * endpoint `/partner/app/{appId}/v3/message`, el campo `type` decide el
 * shape del body. Confirmado contra la documentación OFICIAL de Gupshup
 * Partner (12/sep/2026):
 *   - image:    https://partner-docs.gupshup.io/reference/post_partner-app-appid-v3-image-message
 *   - video:    https://partner-docs.gupshup.io/reference/post_partner-app-appid-v3-video-message
 *   - document: https://partner-docs.gupshup.io/reference/senddocumentmessage
 *
 * IMPORTANTE — esto NO es el mismo shape que gupshup.client.js#sendMediaMessage()
 * (Legacy): ese usa `originalUrl`/`previewUrl` para imagen y `url` plano
 * para video, sobre form-urlencoded. Acá, como con sendTextMessage(), el
 * shape es "estilo WhatsApp Cloud API" (`{type, <type>: {link, caption?}}`,
 * JSON) — son 2 APIs de Gupshup distintas con contratos distintos, no una
 * migración 1:1 del shape.
 *
 * `filename` es OPCIONAL según la documentación de Gupshup para
 * `document` (no obligatorio como se asumió inicialmente al planear este
 * cambio) — sin él, WhatsApp igual entrega el archivo, solo sin un nombre
 * amigable. Se manda igual cuando está disponible, por UX.
 *
 * @param {string} to - número de destino, sin "+"
 * @param {{ url: string, type: 'image'|'video'|'document', caption?: string, filename?: string }} media
 * @param {{ apiKey: string, appId: string }} credentials - mismas credenciales que sendTextMessage()
 * @returns {Promise<object>} JSON crudo de Gupshup
 * @throws {Error} si `media.type` no es uno de los 3 soportados, o si Gupshup responde con un status distinto de 2xx
 */
async function sendMediaMessage(to, media, { apiKey, appId } = {}) {
  if (!TIPOS_MEDIA_SOPORTADOS.includes(media?.type)) {
    throw new Error(`GupshupPartnerClient.sendMediaMessage: tipo de media no soportado "${media?.type}" — debe ser uno de: ${TIPOS_MEDIA_SOPORTADOS.join(', ')}`);
  }

  logger.info('[GupshupPartnerClient] enviando media via Partner API', {
    to,
    appId,
    mediaType: media.type,
    hasApiKey: Boolean(apiKey),
  });

  // Mismo shape para los 3 tipos: { link, caption?, filename? (solo document) }
  // — Gupshup ignora filename en image/video, así que no hace falta
  // condicionar su inclusión salvo por prolijidad del payload.
  const mediaPayload = { link: media.url };
  if (media.caption) mediaPayload.caption = media.caption;
  if (media.type === 'document' && media.filename) mediaPayload.filename = media.filename;

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
      type: media.type,
      [media.type]: mediaPayload,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[GupshupPartnerClient] Partner API respondió error (media)', { status: response.status, body: errText, appId, mediaType: media.type });
    throw new Error(`Gupshup Partner API error (media send): ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[GupshupPartnerClient] media enviada via Partner API exitosamente', { to, appId, mediaType: media.type, gupshupResponse: json });
  return json;
}

/**
 * Lista las plantillas aprobadas del canal vía la API Partner de Gupshup.
 * Reemplaza a gupshup.client.js#listTemplates() (Legacy) para canales con
 * outboundApi:'partner' — bug real de producción (17/sep/2026,
 * docs/post-hardening-diagnostico/ en creaos-backend): gupshupProvider.js#
 * listTemplates() llamaba SIEMPRE al cliente Legacy, sin bifurcar por
 * resolveOutboundMode() como sí hacen sendMessage()/sendMedia() — los 3
 * WhatsAppChannel activos en producción están en modo 'partner', así que
 * sus credenciales (Partner App Access Token) nunca funcionan contra el
 * endpoint Legacy (`api.gupshup.io/wa/app/{appName}/template`, que espera
 * un apikey self-serve) → 401 "Authentication Failed" → 500 en
 * GET /api/v1/whatsapp/templates, siempre.
 *
 * Endpoint confirmado contra la documentación OFICIAL de Gupshup Partner
 * (17/sep/2026): https://partner-docs.gupshup.io/reference/get_partner-app-appid-templates
 * — GET /partner/app/{appId}/templates, mismo header Authorization que
 * sendTextMessage()/sendMediaMessage() (NO "apikey").
 *
 * @param {{ apiKey: string, appId: string }} credentials
 * @returns {Promise<Array>} lista cruda de plantillas tal como las devuelve Gupshup
 */
async function listTemplates({ apiKey, appId } = {}) {
  logger.info('[GupshupPartnerClient] listando plantillas via Partner API', {
    appId,
    hasApiKey: Boolean(apiKey),
  });

  const response = await fetch(`${PARTNER_API_BASE_URL}/partner/app/${appId}/templates`, {
    method: 'GET',
    headers: { Authorization: apiKey },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[GupshupPartnerClient] Partner API respondió error (listar plantillas)', { status: response.status, body: errText, appId });
    throw new Error(`Gupshup Partner API error (template list): ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[GupshupPartnerClient] plantillas listadas via Partner API exitosamente', { appId, cantidad: (json.templates || []).length });
  return json.templates || [];
}

/**
 * Envía un mensaje de plantilla aprobada vía la API Partner de Gupshup —
 * reemplaza a gupshup.client.js#sendTemplateMessage() (Legacy) para
 * canales con outboundApi:'partner'. Mismo bug/mismo motivo que
 * listTemplates() arriba: sendTemplate() en gupshupProvider.js tampoco
 * bifurcaba por resolveOutboundMode().
 *
 * A diferencia de sendTextMessage()/sendMediaMessage() (API v3, JSON,
 * estilo WhatsApp Cloud API), este endpoint es form-urlencoded — mismo
 * shape exacto que gupshup.client.js#sendTemplateMessage() (Legacy): los
 * nombres de campo (`channel`, `source`, `destination`, `src.name`,
 * `template`) son IDÉNTICOS, solo cambia la base URL y el header de auth
 * (Authorization en vez de apikey), igual que en el resto de este
 * archivo. Endpoint confirmado contra la documentación OFICIAL de
 * Gupshup Partner (17/sep/2026):
 * https://partner-docs.gupshup.io/reference/post_partner-app-appid-template-msg
 *
 * @param {string} to
 * @param {{ id: string, params?: string[] }} template — id de la plantilla en
 *   Gupshup y los valores para sus variables {{1}}, {{2}}, ... en orden.
 * @param {{ apiKey: string, appId: string, source: string, appName: string }} credentials —
 *   `source` (número del canal) y `appName` (nombre de la app en Gupshup)
 *   son los mismos campos que ya resuelve gupshupProvider.js#
 *   resolverCredencialesDeEnvio() para el envío de texto/media.
 */
async function sendTemplateMessage(to, template, { apiKey, appId, source, appName } = {}) {
  logger.info('[GupshupPartnerClient] enviando plantilla via Partner API', {
    to,
    appId,
    templateId: template?.id,
    hasApiKey: Boolean(apiKey),
    source,
  });

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: to,
    'src.name': appName,
    template: JSON.stringify({ id: template.id, params: template.params || [] }),
  });

  const response = await fetch(`${PARTNER_API_BASE_URL}/partner/app/${appId}/template/msg`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[GupshupPartnerClient] Partner API respondió error (plantilla)', { status: response.status, body: errText, appId });
    throw new Error(`Gupshup Partner API error (template send): ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[GupshupPartnerClient] plantilla enviada via Partner API exitosamente', { to, appId, gupshupResponse: json });
  return json;
}

module.exports = { sendTextMessage, sendMediaMessage, listTemplates, sendTemplateMessage };
