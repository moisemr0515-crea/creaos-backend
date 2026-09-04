// partner.errors.js — mapea errores crudos del Partner API de Gupshup
// (GupshupHttpError, ver gupshup.http.client.js) a AppError del dominio,
// con mensaje claro y statusCode apropiado. Catálogo verificado el 28 ago
// 2026 contra partner-docs.gupshup.io — ver
// docs/integrations/gupshup-partner-api-contract.md para el detalle por
// endpoint (los códigos de abajo son el catálogo GENERAL documentado;
// varios endpoints comparten el mismo código con mensajes de Gupshup
// distintos, que se propagan tal cual cuando existen).
const { AppError } = require('../../../../../middleware/error.middleware');

/**
 * @param {import('../gupshup.http.client').GupshupHttpError} err
 * @param {string} [context] - qué operación se estaba haciendo, para el mensaje (ej. 'crear app "CREAOS-tenant-42"')
 * @returns {AppError}
 */
function mapPartnerError(err, context = 'operación de Gupshup Partner API') {
  const mensajeGupshup = typeof err.body === 'object' && err.body ? err.body.message || err.body.error : null;

  switch (err.statusCode) {
    case 400:
      // Gupshup documenta varios 400 distintos según el endpoint (nombre de
      // app inválido, longitud inválida, appId inválido, parámetros
      // faltantes, etc.) — su mensaje real ya es específico, se propaga tal cual.
      return new AppError(`Gupshup Partner API rechazó la solicitud (${context}): ${mensajeGupshup || 'parámetros inválidos'}`, 400);

    case 401:
      // NUNCA 401 acá — a propósito, incidente del 04/sep/2026 (ver
      // docs/implementation/known-issues.md y AUTH_SESSION_INVALID_CODE en
      // error.middleware.js). Un 401 de Gupshup (sus credenciales de partner,
      // no las del usuario de CREA OS) reenviado tal cual como HTTP 401 es
      // indistinguible, para el frontend, de "tu sesión de CREA OS expiró" —
      // apiFetch() (crea-os-ignite/src/lib/api/client.ts) deslogueaba al
      // usuario por un problema que no tenía nada que ver con su sesión. 502
      // (Bad Gateway) sigue el mismo criterio que el case 500 de abajo: la
      // falla es del lado del proveedor, no nuestra ni del usuario.
      return new AppError(`Gupshup Partner API: autenticación fallida (${context}) — token de partner inválido, vencido, o header de auth incorrecto para este endpoint`, 502);

    case 403:
      return new AppError(`Gupshup Partner API: acceso denegado (${context})`, 403);

    case 409:
      // Documentado explícitamente para createApp: "Bot Already Exists".
      return new AppError(`Gupshup Partner API: el recurso ya existe (${context}) — ${mensajeGupshup || 'Bot Already Exists'}. El nombre de app debe ser único en toda la cuenta de Gupshup.`, 409);

    case 429:
      return new AppError(`Gupshup Partner API: rate limit excedido (${context}) — máx. 10 requests/60s documentado`, 429);

    case 500:
      // La falla es del lado de Gupshup, no de CREA OS — 502 (Bad Gateway)
      // describe eso con más precisión que propagar un 500 como si el bug
      // fuera nuestro.
      return new AppError(`Gupshup Partner API: error interno del proveedor (${context})`, 502);

    default:
      if (err.status === 'network_error') {
        return new AppError(`Gupshup Partner API no respondió (${context}): ${err.message}`, 504);
      }
      return new AppError(`Gupshup Partner API: error inesperado (${context}, HTTP ${err.statusCode ?? 's/d'})`, 502);
  }
}

module.exports = { mapPartnerError };
