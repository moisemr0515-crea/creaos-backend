// partner.subscriptions.js — Subscription API de Gupshup (notificaciones de
// eventos de una app específica). PR-06 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md).
//
// CORREGIDO el 04/sep/2026 (ver docs/implementation/known-issues.md, entrada
// del mismo día): la versión original de este archivo llamaba a
// `POST https://api.gupshup.io/wa/app/{appId}/subscription` (el endpoint
// "Add Subscription for app" del tier de mensajería "self-serve",
// docs.gupshup.io) con header `apikey`. Esa llamada devolvía 401
// "Authentication Failed" de forma CONSISTENTE (probado en vivo contra
// producción, incluso con reintentos y backoff de hasta 9s) para una app
// recién creada sin ningún WABA todavía asociado — porque ESE endpoint
// pertenece al tier de mensajería, pensado para apps que ya están live.
//
// El endpoint correcto para suscribirse ANTES de que la app esté live es
// otro, documentado por separado en `partner-docs.gupshup.io` bajo "Partner
// App Management → Subscription Management → Set subscription for an app":
//
//   POST https://partner.gupshup.io/partner/app/{appId}/subscription
//
// Con esta nota textual de la propia documentación de Gupshup (verificada
// en vivo, no interpretación de IA): *"Subscriptions can now be set for
// sandbox apps as well. Once the app goes live, the current subscription
// will be retained."* — exactamente nuestro caso: suscribirse ANTES del
// go-live para poder recibir el evento `ACCOUNT_VERIFIED` cuando el
// Embedded Signup se complete.
//
// Diferencias estructurales confirmadas entre ambos endpoints (no
// intercambiables, cada detalle importa):
//   - Host: `partner.gupshup.io` (no `api.gupshup.io`).
//   - Auth: header `Authorization` (no `apikey`) — mismo valor (el apikey
//     de la app, partnerApps.getAppAccessToken()), header distinto.
//   - `modes`: string simple sin corchetes (ej. `"ACCOUNT"`), no
//     `"[ACCOUNT]"` — y el vocabulario de valores válidos es distinto
//     (incluye FLOWS_MESSAGE/PAYMENTS/ALL/COEXISTENCE, no tiene
//     MESSAGE/BILLING).
//   - `version`: debe ser `2` o `3` documentado — no `1`.
//   - No tiene `doCheck`; tiene `showOnUI`/`meta` opcionales, sin uso hoy.
const httpClient = require('../gupshup.http.client');
const { GupshupHttpError } = httpClient;
const { mapPartnerError } = require('./partner.errors');
const { AppError } = require('../../../../../middleware/error.middleware');

// Coincide con gupshup.http.client.js#BASE_URL — se repite acá explícito
// (no se omite el `baseUrl` del request confiando en que coincida con el
// default de otro archivo) para que este módulo siga siendo autocontenido
// si el default de gupshup.http.client.js cambia el día de mañana por otra
// razón (ej. otro endpoint que si viva en un host distinto).
const SUBSCRIPTION_API_BASE_URL = 'https://partner.gupshup.io';

// Retenido como red de seguridad tras el fix del 04/sep — con el endpoint
// correcto (arriba) no debería verse más un 401 por este motivo, pero un
// 401 transitorio real (ej. el token cacheado vence justo entre
// getAppAccessToken() y esta llamada) sigue siendo un caso legítimo para
// reintentar antes de rendirse. Ya NO se reintenta bajo la hipótesis de
// "propagación lenta de Gupshup" (esa hipótesis quedó descartada: el 401
// persistía incluso después de 9s Y de horas transcurridas contra el
// endpoint viejo) — el fix real fue cambiar de endpoint, esto es solo
// tolerancia a fallas transitorias genéricas.
const SUBSCRIPTION_401_RETRY_DELAYS_MS = [1000, 3000, 5000];

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST /partner/app/{appId}/subscription ("Set subscription for an app") —
 * registra una suscripción de eventos para esta app, incluso antes de que
 * tenga un WABA asociado (app "sandbox" — ver comentario del módulo).
 *
 * @param {string} appId
 * @param {string} apikey - de la app puntual (partnerApps.getAppAccessToken())
 * @param {{ url: string, tag: string, modes: string[], version?: number }} params
 *   `modes` se manda como string simple (Gupshup documenta "uno de los
 *   siguientes", no una lista) — si el caller pasa más de un valor, se
 *   concatenan con coma; hoy el único uso real (channel.controller.js) pasa
 *   siempre `['ACCOUNT']`, así que el caso multi-valor no está probado en
 *   vivo contra Gupshup.
 * @returns {Promise<object>} body crudo de Gupshup
 * @throws {AppError} 400 si falta url/tag/modes (validado localmente); el
 *   resto de los errores se mapea vía mapPartnerError() como el resto del
 *   wrapper de Gupshup — incluyendo un 401 persistente después de agotar los
 *   reintentos de SUBSCRIPTION_401_RETRY_DELAYS_MS (ver comentario arriba).
 */
async function subscribeToEvents(appId, apikey, { url, tag, modes, version = 3 } = {}) {
  if (!url || !tag || !Array.isArray(modes) || modes.length === 0) {
    throw new AppError('url, tag y modes (array no vacío) son requeridos para suscribirse a eventos de Gupshup', 400);
  }

  const intentarUnaVez = () =>
    httpClient.request({
      method: 'POST',
      path: `/partner/app/${appId}/subscription`,
      baseUrl: SUBSCRIPTION_API_BASE_URL,
      headers: { Authorization: apikey },
      form: { url, tag, version, modes: modes.join(',') },
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
