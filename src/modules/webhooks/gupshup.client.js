// Cliente delgado de la API de Gupshup (WhatsApp) — sin dependencias hacia
// modelos de Mongo ni hacia ai.service.js/webhook.service.js a propósito.
// webhook.service.js (mensajes ENTRANTES) y ai.service.js (mensajes salientes
// escritos por un agente humano, ver sendAgentMessage) importan ambos desde
// acá. Si `sendWhatsAppMessage` viviera en webhook.service.js como antes,
// que ai.service.js lo importara crearía un require circular:
// webhook.service.js ya importa ai.service.js (para procesar el mensaje
// entrante con la IA) — este módulo es el punto neutral que evita eso.
const logger = require('../../utils/logger');
// PR-07a: GUPSHUP_APP_NAME/GUPSHUP_PHONE_NUMBER dejaron de leerse acá para
// las funciones de ENVÍO (ahora reciben apiKey/source/appName por parámetro,
// resueltos por canal en gupshupProvider.js) — quedan solo las 3 que sigue
// necesitando estaConfigurado()/listTemplates() (status y listado del canal
// PLATFORM, sin cambios en este PR).
const {
  GUPSHUP_API_KEY,
  GUPSHUP_PHONE_NUMBER,
  GUPSHUP_WABA_ID,
  GUPSHUP_APP_ID,
} = require('../../config/env');

/**
 * Envía un mensaje de texto por WhatsApp vía la API de Gupshup.
 *
 * PR-07a (Plan Maestro §3/§5): `apiKey`/`source`/`appName` YA NO se leen de
 * las env vars globales de este módulo — las resuelve gupshupProvider.js por
 * canal (PLATFORM: env vars vía channelCredentials.service.js#resolveCredentials(),
 * mismo valor de siempre; DEDICATED: credenciales reales del tenant,
 * cifradas en ChannelCredentials) y las pasa acá. Este archivo queda ciego a
 * esa distinción a propósito — solo ejecuta la llamada HTTP con lo que le dan.
 *
 * @param {string} to
 * @param {string} message
 * @param {{ apiKey: string, source: string, appName: string }} credentials
 */
async function sendWhatsAppMessage(to, message, { apiKey, source, appName } = {}) {
  logger.info('[gupshup] enviando mensaje via Gupshup API', {
    to,
    hasApiKey: Boolean(apiKey),
    source,
    appName,
  });

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: to,
    message: JSON.stringify({ type: 'text', text: message }),
    'src.name': appName,
  });

  const response = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[gupshup] Gupshup API respondió error', { status: response.status, body: errText });
    throw new Error(`Gupshup API error: ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[gupshup] mensaje enviado a Gupshup exitosamente', { to, gupshupResponse: json });
  return json;
}

/**
 * Config-presence check (no health-check en vivo contra la API de Gupshup a
 * propósito — mantiene el status simple y sin latencia extra ni otro punto
 * de falla). Usado por GET /whatsapp/status (Fix 2, Caso 8).
 */
const estaConfigurado = () =>
  Boolean(GUPSHUP_API_KEY && GUPSHUP_PHONE_NUMBER && GUPSHUP_WABA_ID);

/**
 * Lista las plantillas (WhatsApp Business templates) de la app en Gupshup —
 * a diferencia de sendWhatsAppMessage()/sendTemplateMessage(), esta API es
 * por-app (GUPSHUP_APP_ID, el GUID del dashboard), no por número compartido.
 *
 * Endpoint verificado EN VIVO contra la cuenta real (producción, appId
 * "CREAOS") — la implementación original usaba `sm/api/v1/template/list/
 * {appId}`, que Gupshup rechazaba con 401 "Portal User Not Found With
 * APIKey": ese endpoint pertenece a la familia de API que requiere login
 * de Partner/Portal (usuario+contraseña, no un apikey de app), no la misma
 * familia que ya usa sendWhatsAppMessage()/sendTemplateMessage() (`wa/api/
 * v1/...`, autenticada con el apikey simple de la app). El endpoint
 * correcto para el mismo apikey es `wa/app/{appId}/template` — confirmado
 * con un GET real que devolvió 200 y la plantilla aprobada real de la
 * cuenta ("bienvenidos_creaos"). sendTemplateMessage() (envío, no listado)
 * ya estaba en la familia correcta desde el principio — se probó aparte y
 * respondió 202 sin cambios.
 *
 * GAP CONOCIDO, fuera de alcance de PR-07a a propósito (no es una función de
 * "envío" — es lectura/listado, y el PR se acotó explícitamente a envío):
 * sigue leyendo GUPSHUP_APP_ID/GUPSHUP_API_KEY globales, así que para un
 * canal DEDICATED devolvería siempre las plantillas de la app de Gupshup de
 * CREA OS, no las del tenant. Mismo bug de fondo que sendWhatsAppMessage()
 * tenía antes de este PR — queda documentado para un PR de seguimiento.
 *
 * @returns {Promise<Array>} lista cruda de plantillas tal como las devuelve Gupshup
 */
async function listTemplates() {
  if (!GUPSHUP_APP_ID) {
    throw new Error('GUPSHUP_APP_ID no configurado — requerido para listar plantillas');
  }

  logger.info('[gupshup] listando plantillas', { appId: GUPSHUP_APP_ID });

  const response = await fetch(`https://api.gupshup.io/wa/app/${GUPSHUP_APP_ID}/template`, {
    method: 'GET',
    headers: { apikey: GUPSHUP_API_KEY },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[gupshup] error al listar plantillas', { status: response.status, body: errText });
    throw new Error(`Gupshup API error (template list): ${response.status} ${errText}`);
  }

  const json = await response.json();
  return json.templates || [];
}

/**
 * Envía un mensaje de plantilla aprobada (WhatsApp Business template) —
 * a diferencia de sendWhatsAppMessage() (texto libre), esto NO requiere que
 * la ventana de 24h esté abierta; es justamente el mecanismo para reabrirla.
 *
 * PR-07a: mismo criterio que sendWhatsAppMessage() — `apiKey`/`source`/
 * `appName` llegan resueltos por canal, ya no de env vars globales.
 *
 * @param {string} to
 * @param {{ id: string, params?: string[] }} template — id de la plantilla en
 *   Gupshup y los valores para sus variables {{1}}, {{2}}, ... en orden.
 * @param {{ apiKey: string, source: string, appName: string }} credentials
 */
async function sendTemplateMessage(to, template, { apiKey, source, appName } = {}) {
  logger.info('[gupshup] enviando plantilla via Gupshup API', {
    to,
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

  const response = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[gupshup] Gupshup API respondió error (template)', { status: response.status, body: errText });
    throw new Error(`Gupshup API error (template send): ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[gupshup] plantilla enviada a Gupshup exitosamente', { to, gupshupResponse: json });
  return json;
}

/**
 * Envía un mensaje con media (imagen/video) por WhatsApp — mismo endpoint
 * que sendWhatsAppMessage() (/wa/api/v1/msg), solo cambia el shape del JSON
 * en `message`. Igual que el texto libre, ESTO SÍ requiere la ventana de
 * 24h abierta (Meta trata la media como mensaje de sesión, no de plantilla)
 * — ese chequeo vive en ai.service.js#sendMediaMessage(), no acá.
 *
 * Shape del `message` VERIFICADO contra la referencia OpenAPI oficial de
 * Gupshup para /wa/api/v1/msg (docs.gupshup.io/reference/msg) — NO es el
 * mismo campo para imagen y video, a diferencia de lo que se asumió al
 * implementar esto originalmente:
 *   - image: { type:'image', originalUrl, previewUrl, caption? }
 *   - video: { type:'video', url, caption? }
 * El bug real (reportado y confirmado en producción): se usaba `url` para
 * AMBOS tipos. Para video eso es correcto, pero para imagen Gupshup no
 * reconoce el campo `url` — acepta el request igual (202 "submitted",
 * valida solo los parámetros de nivel superior: channel/source/
 * destination/apikey), pero no tiene ninguna URL de imagen válida que
 * despachar. Por eso nunca llegaba nada al WhatsApp real Y tampoco
 * generaba ningún callback de estado (ni "delivered" ni "failed") —
 * confirmado revisando los logs de un envío real: sin ningún callback en
 * absoluto, a diferencia de un mensaje de texto normal que sí recibe
 * "delivered" en segundos.
 *
 * PR-07a: mismo criterio que sendWhatsAppMessage() — `apiKey`/`source`/
 * `appName` llegan resueltos por canal, ya no de env vars globales.
 *
 * @param {string} to
 * @param {{ url: string, type: 'image'|'video', caption?: string }} media
 * @param {{ apiKey: string, source: string, appName: string }} credentials
 */
async function sendMediaMessage(to, media, { apiKey, source, appName } = {}) {
  logger.info('[gupshup] enviando media via Gupshup API', {
    to,
    mediaType: media?.type,
    hasApiKey: Boolean(apiKey),
    source,
  });

  const messagePayload =
    media.type === 'image'
      ? {
          type: 'image',
          originalUrl: media.url,
          previewUrl: media.url,
          ...(media.caption ? { caption: media.caption } : {}),
        }
      : {
          type: 'video',
          url: media.url,
          ...(media.caption ? { caption: media.caption } : {}),
        };

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: to,
    'src.name': appName,
    message: JSON.stringify(messagePayload),
  });

  const response = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[gupshup] Gupshup API respondió error (media)', { status: response.status, body: errText });
    throw new Error(`Gupshup API error (media send): ${response.status} ${errText}`);
  }

  const json = await response.json();
  logger.info('[gupshup] media enviada a Gupshup exitosamente', { to, gupshupResponse: json });
  return json;
}

/**
 * Descarga el binario de un media ENTRANTE (imagen/video que un lead mandó
 * por WhatsApp) desde la URL que trae el propio payload del webhook de
 * Gupshup (filemanager.gupshup.io/...). Esa URL es TEMPORAL (Gupshup
 * documenta un `urlExpiry`) — quien llame a esto debe descargar y
 * re-alojar en Cloudinary de inmediato (ver ai.service.js#
 * saveInboundMessage()), nunca guardar esta URL tal cual para uso futuro.
 *
 * PR-07a: la media entrante de un canal DEDICATED la sirve filemanager.gupshup.io
 * autenticado con el apikey DE ESA app, no el de PLATFORM — mismo criterio
 * que el resto de este archivo, `apiKey` llega resuelto por canal.
 *
 * @param {string} mediaUrl la URL que vino en el payload entrante (msg.image.url / msg.video.url)
 * @param {{ apiKey: string }} credentials
 * @returns {Promise<{ buffer: Buffer, contentType: string|null }>}
 */
async function downloadMedia(mediaUrl, { apiKey } = {}) {
  logger.info('[gupshup] descargando media entrante', { mediaUrl });

  const response = await fetch(mediaUrl, {
    headers: { apikey: apiKey },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.error('[gupshup] error al descargar media entrante', { status: response.status, body: errText });
    throw new Error(`Gupshup API error (media download): ${response.status} ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: response.headers.get('content-type') };
}

module.exports = { sendWhatsAppMessage, estaConfigurado, listTemplates, sendTemplateMessage, sendMediaMessage, downloadMedia };
