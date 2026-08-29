// partner.subscriptions.js — Subscription API de Gupshup (notificaciones de
// eventos de una app específica). PR-06 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md). Deliberadamente
// separado de partner.apps.js — no es el mismo Partner API de control plane,
// es una API distinta con host y auth propios, confirmado por fuente directa
// el 28 ago 2026 (WebFetch de docs.gupshup.io/reference/addsubscriptionforapp,
// ver docs/integrations/gupshup-registration-contract.md §11.2):
//
//   - Host: api.gupshup.io (NO partner.gupshup.io) — de ahí el `baseUrl`
//     explícito en cada llamada de gupshup.http.client.js#request().
//   - Auth: header `apikey` — el apikey de mensajería DE LA APP puntual
//     (partnerApps.getAppAccessToken()), no el `token` JWT de partner que
//     usa todo partner.apps.js.
//
// Uso actual (único, PR-06): suscribirse en modo ACCOUNT para recibir el
// evento `account-event`/`ACCOUNT_VERIFIED` (Go-Live) en el webhook que ya
// existe (POST /api/v1/webhooks/gupshup) — ver
// channel.controller.js#completeGupshupEmbeddedSignup() y
// channelOnboardingCompletion.service.js.
const httpClient = require('../gupshup.http.client');
const { GupshupHttpError } = httpClient;
const { mapPartnerError } = require('./partner.errors');
const { AppError } = require('../../../../../middleware/error.middleware');

const SUBSCRIPTION_API_BASE_URL = 'https://api.gupshup.io';

/**
 * POST /wa/app/{appId}/subscription — registra (o actualiza, según `doCheck`)
 * una suscripción de eventos para esta app.
 *
 * Parámetros confirmados por fuente directa (mismo WebFetch de arriba): los
 * 5 son requeridos por Gupshup (`url`, `tag`, `version`, `modes`, `doCheck`).
 * `modes` viaja como string con la sintaxis de lista que muestra el ejemplo
 * oficial de la documentación (`[MODO1,MODO2]`), no como array real —
 * `httpClient.request()` solo sabe serializar form-urlencoded plano.
 *
 * La respuesta de éxito NO tiene un shape documentado (confirmado en la
 * misma fuente) — se devuelve el body crudo tal cual, el caller no debe
 * asumir ningún campo puntual.
 *
 * @param {string} appId
 * @param {string} apikey - de la app puntual (partnerApps.getAppAccessToken()), NO el token de partner
 * @param {{ url: string, tag: string, modes: string[], version?: number, doCheck?: boolean }} params
 * @returns {Promise<object>} body crudo de Gupshup
 * @throws {AppError} 400 si falta url/tag/modes (validado localmente); el
 *   resto de los errores se mapea vía mapPartnerError() como el resto del
 *   wrapper de Gupshup.
 */
async function subscribeToEvents(appId, apikey, { url, tag, modes, version = 1, doCheck = true } = {}) {
  if (!url || !tag || !Array.isArray(modes) || modes.length === 0) {
    throw new AppError('url, tag y modes (array no vacío) son requeridos para suscribirse a eventos de Gupshup', 400);
  }

  try {
    const { body } = await httpClient.request({
      method: 'POST',
      path: `/wa/app/${appId}/subscription`,
      baseUrl: SUBSCRIPTION_API_BASE_URL,
      headers: { apikey },
      form: { url, tag, version, modes: `[${modes.join(',')}]`, doCheck },
      idempotent: false, // efecto de auditoría del lado de Gupshup, mismo criterio que login()/createApp()
    });
    return body;
  } catch (err) {
    if (err instanceof GupshupHttpError) throw mapPartnerError(err, `suscripción de eventos de app ${appId}`);
    throw err;
  }
}

module.exports = { subscribeToEvents, SUBSCRIPTION_API_BASE_URL };
