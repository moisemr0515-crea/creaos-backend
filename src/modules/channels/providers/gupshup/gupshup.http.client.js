// gupshup.http.client.js — cliente HTTP base hacia el Partner API de Gupshup
// (https://partner.gupshup.io). PR-02 del blueprint
// CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md (§10-13).
//
// Responsabilidad única: transporte (base URL, timeout, reintentos con
// backoff exponencial, manejo de 429, correlation ID, logging seguro). Este
// cliente NO decide autenticación — cada función de partner/*.js arma sus
// propios headers de auth, a propósito.
//
// Por qué: el Partner API de Gupshup NO usa un header de auth uniforme. La
// documentación oficial (partner-docs.gupshup.io) tiene una inconsistencia
// real y confirmada (28 ago 2026) entre su tabla de parámetros en prosa
// (dice "Authorization") y su spec OpenAPI (dice "token") en varios
// endpoints — la propia doc de "Link App with Partner" se contradice a sí
// misma. Ver docs/integrations/gupshup-partner-api-contract.md para el
// detalle exacto por endpoint. Forzar un header uniforme acá sería asumir
// justo lo que no se puede asumir.
const logger = require('../../../../utils/logger');

const BASE_URL = 'https://partner.gupshup.io';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Se redactan sin importar cuál use el caller — el JWT de partner viaja como
// 'token' O como 'Authorization' según el endpoint (ver nota arriba). 'apikey'
// se suma acá por partner.subscriptions.js (Subscription API, PR-06): ese
// header lleva el apikey real de mensajería de una app específica, no un JWT
// de partner, pero es igual de sensible — nunca se loguea ninguno en texto plano.
const HEADERS_SENSIBLES = new Set(['token', 'authorization', 'apikey']);

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = HEADERS_SENSIBLES.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return redacted;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error tipado de este cliente — partner.errors.js#mapPartnerError() lo
 * traduce a un AppError del dominio. Nunca se loguea `body` de forma
 * insegura acá (podría contener datos del request eco'ados por Gupshup),
 * pero tampoco contiene secretos — los secretos viven en headers, no en el
 * body de las respuestas de error documentadas.
 */
class GupshupHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status: 'client_error'|'server_error'|'network_error', statusCode?: number, body?: any, requestId: string }} details
   */
  constructor(message, { status, statusCode, body, requestId }) {
    super(message);
    this.name = 'GupshupHttpError';
    this.status = status;
    this.statusCode = statusCode;
    this.body = body;
    this.requestId = requestId;
  }
}

/**
 * @param {object} opts
 * @param {'GET'|'POST'|'PUT'|'DELETE'} opts.method
 * @param {string} opts.path - ej. '/partner/account/login'
 * @param {string} [opts.baseUrl] - default: BASE_URL (partner.gupshup.io).
 *   partner.subscriptions.js (PR-06) lo pasa explícito porque la Subscription
 *   API vive en api.gupshup.io, un host completamente distinto — confirmado
 *   en docs/integrations/gupshup-registration-contract.md §11.2.
 * @param {Object<string,string>} [opts.headers]
 * @param {Object<string,string|boolean|undefined>|null} [opts.form] - body x-www-form-urlencoded
 * @param {Object<string,string>|null} [opts.query]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetries]
 * @param {boolean} [opts.idempotent] - default: true solo para GET. Controla
 *   si se reintenta ante 5xx/error de red — reintentar un POST/PUT que ya
 *   pudo haber sido procesado del lado de Gupshup (ej. createApp) arriesga
 *   un efecto secundario duplicado; un GET siempre es seguro de reintentar.
 *   Los 429 SIEMPRE se reintentan sin importar el método — un rate limit se
 *   rechaza antes de procesar nada, nunca deja un efecto secundario a medias.
 * @returns {Promise<{ status: number, body: any, requestId: string }>}
 * @throws {GupshupHttpError}
 */
async function request({
  method,
  path,
  baseUrl = BASE_URL,
  headers = {},
  form = null,
  query = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  idempotent = method === 'GET',
}) {
  const requestId = `gsp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  const finalHeaders = { Accept: 'application/json', 'X-Request-Id': requestId, ...headers };
  let bodyToSend;
  if (form) {
    finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    bodyToSend = params.toString();
  }

  let lastNetworkError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.info('[gupshup.http.client] request', {
        requestId, method, path, attempt, headers: redactHeaders(finalHeaders),
      });

      const response = await fetch(url, { method, headers: finalHeaders, body: bodyToSend, signal: controller.signal });
      clearTimeout(timeoutHandle);

      const rawBody = await response.text();
      let parsedBody = rawBody;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        // Respuesta no-JSON (poco común en este API, pero no se asume) — se
        // deja el texto crudo, el caller decide qué hacer con eso.
      }

      logger.info('[gupshup.http.client] response', { requestId, method, path, statusCode: response.status });

      // 429: siempre se reintenta, sin importar idempotent (ver JSDoc).
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfterHeader = response.headers.get('retry-after');
        const delayMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn('[gupshup.http.client] 429 rate limit, reintentando', { requestId, path, attempt, delayMs });
        await sleep(delayMs);
        continue;
      }

      if (response.status >= 500 && idempotent && attempt < maxRetries) {
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn('[gupshup.http.client] error 5xx, reintentando (idempotente)', {
          requestId, path, statusCode: response.status, attempt, delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        throw new GupshupHttpError(`Gupshup Partner API respondió ${response.status} en ${method} ${path}`, {
          status: response.status >= 500 ? 'server_error' : 'client_error',
          statusCode: response.status,
          body: parsedBody,
          requestId,
        });
      }

      return { status: response.status, body: parsedBody, requestId };
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (err instanceof GupshupHttpError) throw err;

      lastNetworkError = err;
      const esTimeout = err.name === 'AbortError';
      if (idempotent && attempt < maxRetries) {
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn('[gupshup.http.client] error de red, reintentando (idempotente)', {
          requestId, path, attempt, delayMs, error: esTimeout ? 'timeout' : err.message,
        });
        await sleep(delayMs);
        continue;
      }

      // No idempotente (POST/PUT/DELETE): no se reintenta un error de red —
      // no hay forma de saber si Gupshup ya procesó la solicitud del otro
      // lado antes de que la respuesta se perdiera. Se propaga de una.
      throw new GupshupHttpError(
        `Gupshup Partner API: fallo de red en ${method} ${path} (${esTimeout ? 'timeout' : err.message})`,
        { status: 'network_error', requestId }
      );
    }
  }

  throw new GupshupHttpError(
    `Gupshup Partner API: no se pudo completar ${method} ${path} tras ${maxRetries + 1} intento(s) (${lastNetworkError?.message})`,
    { status: 'network_error', requestId }
  );
}

module.exports = { request, GupshupHttpError, BASE_URL };
