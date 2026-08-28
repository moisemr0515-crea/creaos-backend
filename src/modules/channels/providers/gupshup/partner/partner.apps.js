// partner.apps.js — gestión de apps del Partner API de Gupshup (control
// plane, §10.A del blueprint maestro CREA_OS_WhatsApp_Gupshup_Multitenant_
// Architecture_v1.md). Contrato completo, verificado el 28 ago 2026 contra
// partner-docs.gupshup.io — ver docs/integrations/gupshup-partner-api-contract.md.
//
// Cada función recibe el token de partner ya resuelto
// (partner.auth.js#getValidToken()) como último parámetro — este módulo no
// gestiona auth ni cache, queda desacoplado y testeable pasando cualquier
// string como token.
//
// Header de auth: 'token' en los 5 endpoints de este archivo. La
// documentación de Gupshup tiene una inconsistencia real confirmada entre
// su tabla de parámetros en prosa (dice "Authorization" en varios) y su
// spec OpenAPI (dice "token" en todos) — se estandariza acá en 'token' por
// ser lo único consistente entre los specs OpenAPI de los 5 endpoints
// revisados. Si una prueba en vivo contra el Partner Portal real muestra lo
// contrario para algún endpoint puntual, corregir acá Y en el contrato doc.
const httpClient = require('../gupshup.http.client');
const { GupshupHttpError } = httpClient;
const { mapPartnerError } = require('./partner.errors');
const { AppError } = require('../../../../../middleware/error.middleware');

const APP_NAME_MIN_LENGTH = 6;
const APP_NAME_MAX_LENGTH = 150;

function authHeader(token) {
  return { token };
}

async function runOrMap(fn, context) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GupshupHttpError) throw mapPartnerError(err, context);
    throw err;
  }
}

/**
 * POST /partner/app — crea una app de Gupshup nueva, pre-linkeada al
 * Partner ID de la cuenta.
 *
 * @param {{ name: string, templateMessaging?: boolean, disableOptinPrefUrl?: boolean }} params
 * @param {string} token
 * @returns {Promise<{ appId: string }>}
 * @throws {AppError} 400 si `name` no cumple la longitud documentada
 *   (validado localmente acá — el charset exacto de "sin caracteres
 *   especiales" no está documentado con precisión, así que ESE caso puntual
 *   se deja que lo rechace Gupshup, mapeado por partner.errors.js más
 *   abajo, en vez de adivinar una regex); 409 si ya existe una app con ese
 *   nombre ("Bot Already Exists" — el nombre debe ser único en TODA la
 *   cuenta de Gupshup, no solo para CREA OS).
 */
async function createApp({ name, templateMessaging, disableOptinPrefUrl } = {}, token) {
  if (!name || name.length < APP_NAME_MIN_LENGTH || name.length > APP_NAME_MAX_LENGTH) {
    throw new AppError(
      `Nombre de app inválido: debe tener entre ${APP_NAME_MIN_LENGTH} y ${APP_NAME_MAX_LENGTH} caracteres (recibido: ${name ? name.length : 0})`,
      400
    );
  }

  return runOrMap(async () => {
    const form = { name };
    if (templateMessaging !== undefined) form.templateMessaging = templateMessaging;
    if (disableOptinPrefUrl !== undefined) form.disableOptinPrefUrl = disableOptinPrefUrl;

    const { body } = await httpClient.request({
      method: 'POST',
      path: '/partner/app',
      headers: authHeader(token),
      form,
      idempotent: false, // crear la misma app 2 veces por un retry automático es exactamente lo que NO queremos
    });
    return { appId: body.appId };
  }, `crear app "${name}"`);
}

/**
 * PUT /partner/app/{appId}/onboarding/contact — datos de contacto del
 * onboarding (requeridos por Meta para la verificación del negocio).
 *
 * @param {string} appId
 * @param {{ contactEmail: string, contactName: string, contactNumber: string }} contacto
 * @param {string} token
 * @returns {Promise<{ status: string, message: string }>}
 */
async function setContactDetails(appId, { contactEmail, contactName, contactNumber } = {}, token) {
  return runOrMap(async () => {
    const { body } = await httpClient.request({
      method: 'PUT',
      path: `/partner/app/${appId}/onboarding/contact`,
      headers: authHeader(token),
      form: { contactEmail, contactName, contactNumber },
      idempotent: false,
    });
    return body;
  }, `setContactDetails de app ${appId}`);
}

/**
 * POST /partner/app/{appId}/obotoembed/whitelist — whitelistea la app para
 * el flujo de Embedded Signup ("OBO" = on-behalf-of, el modelo de Meta Tech
 * Provider) y devuelve el link firmado para abrir el popup de Meta.
 *
 * NO confundir con GET /partner/app/{appId}/onboarding/embed/link, un
 * endpoint DISTINTO y más viejo de Gupshup para un flujo de onboarding sin
 * Embedded Signup — no es el que necesita CREA OS acá. Ver el contrato doc
 * para el detalle de por qué se descartó ese otro endpoint.
 *
 * @param {string} appId
 * @param {string} token
 * @returns {Promise<{ embedSignupUrl: string, id: string }>}
 */
async function generateEmbedSignupLink(appId, token) {
  return runOrMap(async () => {
    const { body } = await httpClient.request({
      method: 'POST',
      path: `/partner/app/${appId}/obotoembed/whitelist`,
      headers: authHeader(token),
      idempotent: false,
    });
    return { embedSignupUrl: body.embedSignupUrl, id: body.id };
  }, `generateEmbedSignupLink de app ${appId}`);
}

/**
 * POST /partner/account/api/appLink — asocia una app YA EXISTENTE (por
 * apiKey) a la cuenta partner. Requiere MFA habilitado en la cuenta
 * partner — ya confirmado que la cuenta de CREA OS lo tiene.
 *
 * @param {{ apiKey: string, appName: string }} params
 * @param {string} token
 * @returns {Promise<{ partnerApps: object }>}
 */
async function linkAppWithPartner({ apiKey, appName } = {}, token) {
  return runOrMap(async () => {
    const { body } = await httpClient.request({
      method: 'POST',
      path: '/partner/account/api/appLink',
      headers: authHeader(token),
      form: { apiKey, appName },
      idempotent: false,
    });
    return body;
  }, `linkAppWithPartner "${appName}"`);
}

/**
 * GET /partner/app/{appId}/obotoembed/verify — último paso del Embedded
 * Signup: verifica la WABA ya whitelisteada y le adjunta la línea de
 * crédito de Gupshup.
 *
 * @param {string} appId
 * @param {string} token
 * @returns {Promise<{ status: string, message: string }>}
 */
async function verifyAndAttachCreditLine(appId, token) {
  return runOrMap(async () => {
    const { body } = await httpClient.request({
      method: 'GET',
      path: `/partner/app/${appId}/obotoembed/verify`,
      headers: authHeader(token),
      // idempotent: true (default de GET) — está bien reintentar una
      // verificación de estado ante un 5xx/timeout.
    });
    return body;
  }, `verifyAndAttachCreditLine de app ${appId}`);
}

module.exports = {
  createApp,
  setContactDetails,
  generateEmbedSignupLink,
  linkAppWithPartner,
  verifyAndAttachCreditLine,
  APP_NAME_MIN_LENGTH,
  APP_NAME_MAX_LENGTH,
};
