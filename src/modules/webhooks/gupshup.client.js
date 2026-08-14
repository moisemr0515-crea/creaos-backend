// Cliente delgado de la API de Gupshup (WhatsApp) — sin dependencias hacia
// modelos de Mongo ni hacia ai.service.js/webhook.service.js a propósito.
// webhook.service.js (mensajes ENTRANTES) y ai.service.js (mensajes salientes
// escritos por un agente humano, ver sendAgentMessage) importan ambos desde
// acá. Si `sendWhatsAppMessage` viviera en webhook.service.js como antes,
// que ai.service.js lo importara crearía un require circular:
// webhook.service.js ya importa ai.service.js (para procesar el mensaje
// entrante con la IA) — este módulo es el punto neutral que evita eso.
const logger = require('../../utils/logger');
const {
  GUPSHUP_API_KEY,
  GUPSHUP_APP_NAME,
  GUPSHUP_PHONE_NUMBER,
  GUPSHUP_WABA_ID,
} = require('../../config/env');

/**
 * Envía un mensaje de texto por WhatsApp vía la API de Gupshup.
 * Único número compartido por ahora (GUPSHUP_PHONE_NUMBER) — no recibe un
 * origen configurable por negocio. Cuando exista el número dedicado por
 * negocio (v1.2, ticket #264467), el cambio queda acotado a esta función.
 */
async function sendWhatsAppMessage(to, message) {
  logger.info('[gupshup] enviando mensaje via Gupshup API', {
    to,
    hasApiKey: Boolean(GUPSHUP_API_KEY),
    source: GUPSHUP_PHONE_NUMBER,
    appName: GUPSHUP_APP_NAME,
  });

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: GUPSHUP_PHONE_NUMBER,
    destination: to,
    message: JSON.stringify({ type: 'text', text: message }),
    'src.name': GUPSHUP_APP_NAME,
  });

  const response = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      apikey: GUPSHUP_API_KEY,
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

module.exports = { sendWhatsAppMessage, estaConfigurado };
