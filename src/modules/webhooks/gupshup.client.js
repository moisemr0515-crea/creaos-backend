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
  GUPSHUP_APP_ID,
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

/**
 * Lista las plantillas (WhatsApp Business templates) de la app en Gupshup —
 * a diferencia de sendWhatsAppMessage()/sendTemplateMessage(), esta API es
 * por-app (GUPSHUP_APP_ID, el GUID del dashboard), no por número compartido.
 * Implementado según la documentación estándar de Gupshup (API "sm/api/v1") —
 * sin health-check propio en esta sesión contra la cuenta real todavía;
 * primer uso en producción sirve como verificación en vivo del shape exacto
 * de la respuesta (mismo criterio que se usó para sendWhatsAppMessage en su
 * momento).
 *
 * @returns {Promise<Array>} lista cruda de plantillas tal como las devuelve Gupshup
 */
async function listTemplates() {
  if (!GUPSHUP_APP_ID) {
    throw new Error('GUPSHUP_APP_ID no configurado — requerido para listar plantillas');
  }

  logger.info('[gupshup] listando plantillas', { appId: GUPSHUP_APP_ID });

  const response = await fetch(`https://api.gupshup.io/sm/api/v1/template/list/${GUPSHUP_APP_ID}`, {
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
 * @param {string} to
 * @param {{ id: string, params?: string[] }} template — id de la plantilla en
 *   Gupshup y los valores para sus variables {{1}}, {{2}}, ... en orden.
 */
async function sendTemplateMessage(to, template) {
  logger.info('[gupshup] enviando plantilla via Gupshup API', {
    to,
    templateId: template?.id,
    hasApiKey: Boolean(GUPSHUP_API_KEY),
    source: GUPSHUP_PHONE_NUMBER,
  });

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: GUPSHUP_PHONE_NUMBER,
    destination: to,
    'src.name': GUPSHUP_APP_NAME,
    template: JSON.stringify({ id: template.id, params: template.params || [] }),
  });

  const response = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: {
      apikey: GUPSHUP_API_KEY,
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

module.exports = { sendWhatsAppMessage, estaConfigurado, listTemplates, sendTemplateMessage };
