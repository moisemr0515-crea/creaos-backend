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

// Incidente del 04/sep/2026 (ver docs/implementation/known-issues.md): el
// primer intento real de completar un Embedded Signup en producción llamó a
// subscribeToEvents() ~1-2s después de que createApp() devolviera 200, y
// Gupshup respondió 401 "Authentication Failed" al apikey de la app recién
// creada — el mismo apikey que GET /partner/app/{appId}/token acababa de
// confirmar como válido segundos antes.
//
// HIPÓTESIS NO CONFIRMADA CON SOPORTE DE GUPSHUP: la Subscription API
// (api.gupshup.io) y el Partner API de control plane (partner.gupshup.io)
// son sistemas separados (ver comentario de arriba) — es plausible que el
// apikey de una app recién creada tarde un momento en propagarse al primero
// aunque el segundo ya lo reconozca. No hay confirmación oficial de esto ni
// de cuánto tarda esa propagación en el peor caso. Si este backoff no
// resuelve el problema de raíz, o si Gupshup confirma/descarta esta
// hipótesis, revisar acá primero.
//
// Se reintenta ÚNICAMENTE ante un 401 de Gupshup — un 400/403/409/429 no es
// un problema de timing, reintentarlo ciegamente no cambiaría el resultado y
// desperdiciaría cupo del rate limit documentado (10 requests/60s). Delays
// progresivos (no un intervalo fijo) para darle más margen a cada intento
// sucesivo sin alargar de más el caso feliz cuando alcanza con poco.
const SUBSCRIPTION_401_RETRY_DELAYS_MS = [1000, 3000, 5000];

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 *   wrapper de Gupshup — incluyendo un 401 persistente después de agotar los
 *   reintentos de SUBSCRIPTION_401_RETRY_DELAYS_MS (ver comentario arriba).
 */
async function subscribeToEvents(appId, apikey, { url, tag, modes, version = 1, doCheck = true } = {}) {
  if (!url || !tag || !Array.isArray(modes) || modes.length === 0) {
    throw new AppError('url, tag y modes (array no vacío) son requeridos para suscribirse a eventos de Gupshup', 400);
  }

  const intentarUnaVez = () =>
    httpClient.request({
      method: 'POST',
      path: `/wa/app/${appId}/subscription`,
      baseUrl: SUBSCRIPTION_API_BASE_URL,
      headers: { apikey },
      form: { url, tag, version, modes: `[${modes.join(',')}]`, doCheck },
      idempotent: false, // efecto de auditoría del lado de Gupshup, mismo criterio que login()/createApp()
    });

  // <= (no <) SUBSCRIPTION_401_RETRY_DELAYS_MS.length: el intento 0 es el
  // pedido original, los siguientes son los reintentos — así que hacen falta
  // length+1 pasadas totales para agotar todos los delays documentados.
  for (let intento = 0; intento <= SUBSCRIPTION_401_RETRY_DELAYS_MS.length; intento += 1) {
    try {
      const { body } = await intentarUnaVez();
      return body;
    } catch (err) {
      if (!(err instanceof GupshupHttpError)) throw err;

      const quedanReintentos = intento < SUBSCRIPTION_401_RETRY_DELAYS_MS.length;
      if (err.statusCode !== 401 || !quedanReintentos) {
        throw mapPartnerError(err, `suscripción de eventos de app ${appId}`);
      }

      // Solo llega acá con un 401 y reintentos disponibles — espera el delay
      // progresivo de este intento y prueba de nuevo, sin loguear cada paso
      // acá (el caller/logger de más arriba ya audita la llamada completa).
      await esperar(SUBSCRIPTION_401_RETRY_DELAYS_MS[intento]);
    }
  }

  // Inalcanzable en la práctica (el loop siempre retorna o tira dentro del
  // catch) — solo para que la función tenga un tipo de retorno consistente
  // si algún día se toca la condición del for sin darse cuenta.
  throw new AppError(`suscripción de eventos de app ${appId}: se agotaron los reintentos sin una respuesta`, 502);
}

module.exports = { subscribeToEvents, SUBSCRIPTION_API_BASE_URL, SUBSCRIPTION_401_RETRY_DELAYS_MS };
