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
// Header de auth: 'token' en los 6 endpoints de este archivo. La
// documentación de Gupshup tiene una inconsistencia real confirmada entre
// su tabla de parámetros en prosa (dice "Authorization" en varios) y su
// spec OpenAPI (dice "token" en todos) — se estandariza acá en 'token' por
// ser lo único consistente entre los specs OpenAPI revisados. Si una prueba
// en vivo contra el Partner Portal real muestra lo contrario para algún
// endpoint puntual, corregir acá Y en el contrato doc.
//
// IMPORTANTE (PR-05, confirmado con fuente humana de Gupshup + Partner
// Portal propio — ver docs/integrations/gupshup-registration-contract.md
// §9): generateEmbedSignupLink()/verifyAndAttachCreditLine() (obotoembed/
// whitelist+verify) NO se usan en el flujo principal de onboarding —
// quedan reservados para un futuro caso de migración (OBO→Embed, o desde
// otro BSP). El flujo de altas 100% nuevas usa getEmbedSignupLink()
// (onboarding/embed/link), agregada en PR-05.
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
 * POST /partner/app/{appId}/obotoembed/whitelist — whitelistea una WABA para
 * el flujo "OBO to Embed" de Gupshup.
 *
 * RESERVADO PARA MIGRACIÓN, NO PARA ALTAS NUEVAS (corregido en PR-05 —
 * confirmado con fuente humana de Gupshup + verificación propia en su
 * Partner Portal, ver docs/integrations/gupshup-registration-contract.md
 * §9): este endpoint vive en la categoría "OBO to Embed flow" de Gupshup,
 * específicamente para migrar una WABA que ya estaba onboardeada en el
 * modelo OBO (u otro BSP) hacia el modelo Embed — NO para un tenant que
 * nunca tuvo WABA en Gupshup. Ese caso (el de CREA OS hoy) usa
 * getEmbedSignupLink() (`onboarding/embed/link`), agregada en PR-05. Se
 * conserva esta función implementada — puede servir el día que CREA OS
 * necesite migrar un tenant con WABA preexistente — pero nada del flujo
 * principal de onboarding la llama.
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

/**
 * GET /partner/app/{appId}/onboarding/embed/link — genera el link de
 * onboarding embebido para altas 100% nuevas (PR-05). Confirmado como el
 * endpoint correcto para este caso — a diferencia de
 * generateEmbedSignupLink()/verifyAndAttachCreditLine() de arriba (esos son
 * para migración) — con 2 fuentes independientes: un contacto humano de
 * Gupshup por escrito, y el Ask AI de su documentación citando el manual.
 * Ver docs/integrations/gupshup-registration-contract.md §7-9.
 *
 * El link generado es válido 5 días (documentado por Gupshup). No se
 * `idempotent:true` a propósito aunque el método sea GET — Gupshup limita
 * la cantidad de links nuevos/regeneraciones que se pueden pedir (máx. 5
 * nuevos, máx. 40 regeneraciones documentado en su catálogo de errores);
 * un retry automático de nuestro cliente HTTP quemando ese cupo sin que el
 * caller lo sepa sería peor que fallar una vez y dejar que se reintente
 * explícitamente.
 *
 * @param {string} appId
 * @param {{ user: string, lang: string, regenerate?: boolean }} params
 * @param {string} token
 * @returns {Promise<{ link: string }>}
 * @throws {AppError} 400 si faltan `user`/`lang` (validado localmente —
 *   Gupshup también lo valida, pero devolver el 400 antes de la llamada de
 *   red es más rápido y más claro); el resto de los errores documentados
 *   (401 appId/token incorrecto, 429, 500 "Max link already sent" etc.) se
 *   mapean vía mapPartnerError() como el resto de este archivo.
 */
async function getEmbedSignupLink(appId, { user, lang, regenerate = false } = {}, token) {
  if (!user || !lang) {
    throw new AppError('user y lang son requeridos para generar el embed signup link', 400);
  }

  return runOrMap(async () => {
    const { body } = await httpClient.request({
      method: 'GET',
      path: `/partner/app/${appId}/onboarding/embed/link`,
      headers: authHeader(token),
      query: { user, lang, regenerate },
      idempotent: false,
    });
    return { link: body.link };
  }, `getEmbedSignupLink de app ${appId}`);
}

module.exports = {
  createApp,
  setContactDetails,
  generateEmbedSignupLink,
  linkAppWithPartner,
  verifyAndAttachCreditLine,
  getEmbedSignupLink,
  APP_NAME_MIN_LENGTH,
  APP_NAME_MAX_LENGTH,
};
