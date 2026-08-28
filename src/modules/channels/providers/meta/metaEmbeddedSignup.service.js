// metaEmbeddedSignup.service.js — canje de code + resolución de número real
// para el flujo de Meta WhatsApp Embedded Signup. PR-04 del blueprint
// maestro (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §21-22).
//
// Contrato verificado el 28 ago 2026 contra developers.facebook.com — ver
// docs/integrations/meta-embedded-signup-contract.md §3-4. NO reutiliza ni
// modifica metaOauth.service.js (Facebook Lead Ads, dominio distinto,
// confirmado en esa misma investigación) — comparte solo el *patrón* de
// fetch a graph.facebook.com, no código.
const { AppError } = require('../../../../middleware/error.middleware');
const { normalizeToE164 } = require('../../../../utils/phone');
const { META_APP_ID, META_APP_SECRET, META_GRAPH_API_VERSION } = require('../../../../config/env');

const GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

/**
 * GET /oauth/access_token — canjea el `code` de Embedded Signup por un
 * Business Integration System User access token. Sin `redirect_uri`, a
 * diferencia del flujo de Lead Ads (contrato §3, confirmado).
 *
 * Fail-loud: nunca devuelve null/undefined en silencio — cualquier
 * respuesta sin `access_token`, o un !res.ok, tira AppError.
 *
 * @param {string} code
 * @returns {Promise<string>} el access token en texto plano — quien llama
 *   decide cómo cifrarlo/persistirlo, este servicio no toca Mongo.
 * @throws {AppError} 500 si faltan META_APP_ID/META_APP_SECRET, 502 si
 *   Meta rechaza el code o responde algo inesperado.
 */
async function exchangeCode(code) {
  if (!META_APP_ID || !META_APP_SECRET) {
    throw new AppError('META_APP_ID/META_APP_SECRET no configurados', 500);
  }
  if (!code || typeof code !== 'string') {
    throw new AppError('code inválido', 400);
  }

  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    code,
  }).toString();

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.access_token) {
    // Mismo criterio que Gupshup en PR-02 (partner.errors.js): la falla es
    // del proveedor externo, no nuestra — 502, no 500.
    throw new AppError(json.error?.message || 'Meta no devolvió un access_token válido al canjear el code', 502);
  }

  return json.access_token;
}

/**
 * GET /{wabaId}/phone_numbers — resuelve el número real (E.164) a partir
 * del phoneNumberId que ya entregó el postMessage de Embedded Signup
 * (contrato §4, confirmado — wabaId/phoneNumberId en sí NO necesitan
 * ninguna llamada a la Graph API, solo el número de teléfono).
 *
 * @param {string} wabaId
 * @param {string} phoneNumberId
 * @param {string} accessToken - el token en texto plano (ya descifrado por
 *   quien llama; este servicio no conoce ChannelOnboardingSession ni cifrado)
 * @returns {Promise<{ phoneNumber: string, verifiedName: string|null }>}
 * @throws {AppError} 502 si Meta responde error, o si ningún número de la
 *   WABA matchea el phoneNumberId dado (fail-loud — nunca devuelve un
 *   resultado parcial o adivinado).
 */
async function resolvePhoneNumber(wabaId, phoneNumberId, accessToken) {
  if (!wabaId || !phoneNumberId || !accessToken) {
    throw new AppError('wabaId, phoneNumberId y accessToken son requeridos', 400);
  }

  const url = new URL(`${GRAPH_BASE}/${wabaId}/phone_numbers`);
  url.search = new URLSearchParams({ access_token: accessToken }).toString();

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new AppError(json.error?.message || 'No se pudo obtener los números de teléfono de la WABA', 502);
  }

  const match = (json.data || []).find((phone) => phone.id === phoneNumberId);
  if (!match) {
    throw new AppError(`phoneNumberId "${phoneNumberId}" no encontrado entre los números de la WABA "${wabaId}"`, 502);
  }

  // Meta devuelve display_phone_number con espacios/guiones (ej. "+1
  // 631-555-5556"), no E.164 estricto (contrato §4, confirmado). Cualquier
  // número real de Meta trae el código de país incluido, así que
  // normalizeToE164() siempre cae en la rama ">9 dígitos → anteponer +" —
  // nunca en la rama que asume Perú por default, esa solo aplica a
  // números locales de 9 dígitos sin código de país (leads, no WABAs).
  return {
    phoneNumber: normalizeToE164(match.display_phone_number),
    verifiedName: match.verified_name || null,
  };
}

module.exports = { exchangeCode, resolvePhoneNumber };
