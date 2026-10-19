// channel.controller.js — handlers HTTP del módulo channels/ (primera vez
// que expone rutas propias). PR-03 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §19-20): SOLO el
// endpoint de init del Embedded Signup. El callback de Meta (§21, PR-04) y
// cualquier llamada real a Gupshup Partner API (createApp() y el resto,
// PR-05+) todavía no existen — esta sesión se completa recién en esos PRs.
const mongoose = require('mongoose');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const channelCrypto = require('./channelCrypto');
const metaEmbeddedSignup = require('./providers/meta/metaEmbeddedSignup.service');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito, respuestaError } = require('../../utils/response');
const logger = require('../../utils/logger');
const channelService = require('./channel.service');
const channelCredentialsService = require('./channelCredentials.service');
const channelOnboardingApp = require('./channelOnboardingApp.service');
const completionService = require('./channelOnboardingCompletion.service');
const channelOnboardingStatus = require('./channelOnboardingStatus.service');
const channelOnboardingRecovery = require('./channelOnboardingRecovery.service');
const channelOnboardingLink = require('./channelOnboardingLink.service');
const { GUPSHUP_PHASE_WINDOW_MS, RECONCILE_INITIAL_STATE } = ChannelOnboardingSession;
const { META_APP_ID, META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, BACKEND_PUBLIC_URL, GUPSHUP_ONBOARDING_WEBHOOK_TOKEN, GUPSHUP_WEBHOOK_HEADER, GUPSHUP_WEBHOOK_TOKEN } = require('../../config/env');
// Constante compartida vía un archivo sin dependencias propias — NO se
// importa directo de channelOnboardingWebhook.controller.js acá (ese módulo
// requiere channelOnboardingCompletion.service.js, que a su vez requiere
// ESTE archivo para nombreAppGupshup() — hacerlo formaría un ciclo real que
// dejaría nombreAppGupshup `undefined` del otro lado). Ver el comentario en
// channelOnboardingWebhook.constants.js para el detalle completo.
const { ONBOARDING_WEBHOOK_HEADER } = require('./channelOnboardingWebhook.constants');
// Marcador propio para session.gupshup.webhookReference — la Subscription
// API de Gupshup no devuelve ningún ID de suscripción documentado (ver
// docs/integrations/gupshup-registration-contract.md §11.2), así que este
// campo no guarda un ID real de Gupshup, solo constancia de "ya nos
// suscribimos". channelOnboardingCompletion.service.js (PR-06) lo copia tal
// cual a WhatsAppChannel.webhookReference al completar el onboarding — no
// necesita conocer este valor puntual, solo hace passthrough.
const GUPSHUP_ACCOUNT_SUBSCRIPTION_MARKER = 'gupshup:account-subscribed';
// Mismo criterio que el marcador de arriba, para la SEGUNDA suscripción
// (mensajería) agregada el 06/sep/2026 (docs/implementation/known-issues.md)
// — independiente de la de ACCOUNT, ver el bloque correspondiente más abajo.
const GUPSHUP_MESSAGES_SUBSCRIPTION_MARKER = 'gupshup:messages-subscribed';
const GUPSHUP_MESSAGES_SUBSCRIPTION_TAG = 'creaos-messages';

const reassignConversationChannel = async (req, res, next) => {
  try {
    const conversation = await channelService.reassignConversationChannel({
      conversationId: req.params.conversationId,
      channelId: req.body.channelId,
      tenantId: req.businessId,
      actorId: req.user._id,
      reason: req.body.reason,
    });
    return respuestaExito(res, { message: 'Canal de la conversación reasignado', data: { conversation } });
  } catch (err) { return next(err); }
};

const disconnectChannel = async (req, res, next) => {
  try {
    const result = await channelCredentialsService.revokeAllForChannel({
      channelId: req.params.channelId,
      tenantId: req.businessId,
      actorId: req.user._id,
    });
    return respuestaExito(res, { message: 'Canal de WhatsApp desconectado', data: result });
  } catch (err) { return next(err); }
};

const rotateChannelCredential = async (req, res, next) => {
  try {
    const result = await channelCredentialsService.rotateApiKey({
      channelId: req.params.channelId,
      tenantId: req.businessId,
      apiKey: req.body.apiKey,
      label: req.body.label,
    });
    return respuestaExito(res, { message: 'Credencial rotada', data: result });
  } catch (err) { return next(err); }
};

const revokeChannelCredential = async (req, res, next) => {
  try {
    const result = await channelCredentialsService.revokeApiKey({
      channelId: req.params.channelId,
      tenantId: req.businessId,
      credentialId: req.params.credentialId,
      actorId: req.user._id,
      reason: req.body.reason,
    });
    return respuestaExito(res, { message: 'Credencial revocada', data: result });
  } catch (err) { return next(err); }
};

const DISPLAY_NAME_MAX_LENGTH = 100;

// Estados de ChannelOnboardingSession que cuentan como "sin terminar" (ver
// STATUSES en channelOnboardingSession.model.js) — completed/failed/expired
// no compiten por nada, no hace falta ni contarlos. Incluye los 3 estados de
// reclamo atómico (exchanging_code/resolving_number/completing) — una
// sesión a mitad de un reclamo también está "sin terminar", y también debe
// poder vencer por expiración perezosa si queda huérfana ahí por un crash
// del proceso a mitad de camino (ver claimSessionForStep()).
const ESTADOS_SIN_TERMINAR = [
  'initiated', 'exchanging_code', 'meta_authorized', 'resolving_number', 'gupshup_registering', 'completing',
];

// Mensajes por estado cuando NO coincide con el esperado por el paso actual
// (PR-04, blueprint maestro §21-22). exchanging_code/resolving_number/
// completing casi nunca deberían mostrarse de verdad a un usuario — son
// estados de milisegundos (el tiempo de una sola llamada HTTP externa) — pero
// tienen mensaje propio por completitud, para el caso borde de que otro
// request choque justo en esa ventana.
const MENSAJES_ESTADO_INVALIDO = {
  initiated: 'Falta completar el paso anterior (/code) antes de continuar.',
  exchanging_code: 'Tu conexión con Meta está en proceso — esperá un momento y probá de nuevo.',
  meta_authorized: 'La sesión ya avanzó más allá de este paso.',
  resolving_number: 'Estamos confirmando los datos de tu WhatsApp Business — esperá un momento y probá de nuevo.',
  gupshup_registering: 'La sesión ya avanzó más allá de este paso.',
  completing: 'Estamos terminando de configurar tu canal de WhatsApp — esperá un momento.',
  completed: 'La sesión ya se completó.',
  failed: 'La sesión falló — hay que reiniciar el onboarding desde /init.',
  expired: 'La sesión expiró — hay que reiniciar el onboarding desde /init.',
};

/**
 * Sesión encontrada pero en un estado distinto al esperado por este paso.
 * Se maneja aparte de AppError porque el shape de respuesta acordado
 * (INVALID_SESSION_STATE) incluye `currentState`, algo que AppError no
 * carga — se atrapa explícito en cada handler, nunca llega al error
 * middleware genérico ni se confunde con un 404/500 real.
 */
class InvalidSessionStateError extends Error {
  constructor(currentState) {
    super(MENSAJES_ESTADO_INVALIDO[currentState] || `La sesión está en un estado inesperado: "${currentState}"`);
    this.name = 'InvalidSessionStateError';
    this.currentState = currentState;
  }
}

// Contexto de derivación de channelCrypto.js para el token de Meta de una
// sesión — el WhatsAppChannel real todavía no existe en este punto del
// flujo, así que no hay un channelId real (ver channelOnboardingSession.model.js).
function sessionCryptoContext(session) {
  return `onboarding:${session._id}`;
}

/**
 * Busca la sesión (nunca distingue "no existe" de "es de otro tenant" —
 * mismo 404 para ambos casos, aislamiento estructural), aplica la
 * expiración perezosa, y recién después valida el estado esperado.
 *
 * La expiración se chequea SIEMPRE contra cualquier estado sin terminar,
 * no solo el esperado por este paso puntual — `expiresAt` es una ventana
 * fija desde el `init()` (30 min), no algo que se renueve por paso.
 *
 * @param {string} sessionId
 * @param {import('mongoose').Types.ObjectId} tenantId
 * @param {string|string[]} expectedStatus - uno o más estados válidos para
 *   este paso (ej. `complete-gupshup` acepta `['gupshup_registering',
 *   'failed']` para poder reintentar tras un fallo transitorio de Gupshup
 *   sin obligar a reiniciar todo el onboarding — ver esa función para el
 *   chequeo adicional de que el `failed` sea de este mismo paso).
 * @returns {Promise<import('./channelOnboardingSession.model')>}
 * @throws {AppError} 404 si no existe / no es del tenant.
 * @throws {InvalidSessionStateError} si el estado no es ninguno de los
 *   esperados (incluye el caso recién expirado, con currentState:'expired').
 */
async function loadSessionForStep(sessionId, tenantId, expectedStatus) {
  const estadosValidos = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

  const session = await ChannelOnboardingSession.findOne({ _id: sessionId, tenantId });
  if (!session) {
    throw new AppError('Sesión de onboarding no encontrada', 404);
  }

  if (ESTADOS_SIN_TERMINAR.includes(session.status) && session.expiresAt < new Date()) {
    session.status = 'expired';
    await session.save();
  }

  if (!estadosValidos.includes(session.status)) {
    throw new InvalidSessionStateError(session.status);
  }

  return session;
}

/**
 * Variante atómica de loadSessionForStep() — usada por /code y /callback
 * (fix de idempotencia/race condition; NO por /complete-gupshup, que acepta
 * un array de estados y tiene su propia lógica de reintento ya probada
 * desde PR-05 — queda fuera de este fix a propósito, menor riesgo de
 * regresión). Mismo patrón que outbound.worker.js:31-35
 * (findOneAndUpdate({_id,status:'pending'},{status:'processing'})): reclama
 * la sesión con un solo findOneAndUpdate filtrando por el estado esperado,
 * en vez de leer y comparar en memoria antes de guardar.
 *
 * Elimina la ventana entre "leer el estado" y "guardar" donde 2 requests
 * concurrentes para la MISMA sesión (reintento de red por timeout, doble
 * click sobre "Conectar WhatsApp", etc.) podían pasar ambas el chequeo de
 * loadSessionForStep() y terminar pisándose el resultado en el `save()`
 * final — con el reclamo atómico, el que pierde la carrera nunca llega a
 * hacer ningún save() (ve `null`, tira InvalidSessionStateError de una),
 * así que no hay forma de que corrompa el resultado del que ganó.
 *
 * @param {string} sessionId
 * @param {import('mongoose').Types.ObjectId} tenantId
 * @param {string} expectedStatus - un único estado esperado (a diferencia
 *   de loadSessionForStep(), acá no hace falta un array — /code y /callback
 *   siempre esperan exactamente un estado previo).
 * @param {string} claimStatus - estado transitorio al que se mueve
 *   atómicamente la sesión si gana la carrera (ej. 'exchanging_code'). El
 *   caller es responsable de moverlo al estado final real en caso de éxito,
 *   o a 'failed' vía markSessionFailed() en caso de error, antes de
 *   terminar. Dejar una sesión en `claimStatus` para siempre ante un crash
 *   del proceso a mitad de camino es un caso borde aceptado — mismo
 *   criterio que la limitación ya documentada en
 *   channelOnboardingCompletion.service.js para el estado 'completing'.
 * @returns {Promise<import('./channelOnboardingSession.model')>} el
 *   documento YA en `claimStatus`.
 * @throws {AppError} 404 si no existe / no es del tenant.
 * @throws {InvalidSessionStateError} si existe pero no está en
 *   `expectedStatus` — cubre tanto "genuinamente en otro estado" como
 *   "perdió la carrera contra otro request concurrente para esta misma
 *   sesión". Los 2 casos son indistinguibles desde acá a propósito: la
 *   respuesta correcta es la misma en ambos, 409 con el estado actual.
 */
async function claimSessionForStep(sessionId, tenantId, expectedStatus, claimStatus) {
  const session = await ChannelOnboardingSession.findOne({ _id: sessionId, tenantId });
  if (!session) {
    throw new AppError('Sesión de onboarding no encontrada', 404);
  }

  // Expiración perezosa PRIMERO, igual que loadSessionForStep() — antes de
  // intentar reclamar, para no reclamar una sesión que en realidad ya
  // venció. Esta lectura/guardado no necesita ser atómico: el reclamo real
  // de abajo sí lo es, y evalúa el estado vigente en Mongo en el momento
  // exacto del update, no el que se leyó acá arriba — 2 requests
  // concurrentes leyendo este `if` a la vez no reabren la ventana de la
  // carrera, porque ninguno de los 2 puede ganar el reclamo si el otro ya
  // lo ganó primero.
  if (ESTADOS_SIN_TERMINAR.includes(session.status) && session.expiresAt < new Date()) {
    session.status = 'expired';
    await session.save();
  }

  const reclamada = await ChannelOnboardingSession.findOneAndUpdate(
    { _id: sessionId, tenantId, status: expectedStatus },
    { $set: { status: claimStatus } },
    { new: true }
  );

  if (!reclamada) {
    // Se relee para reportar el estado REAL en el 409 (pudo haber expirado
    // recién arriba, o perdido la carrera contra otro request concurrente,
    // o genuinamente estar en otro estado) — mismo shape de error que
    // loadSessionForStep(). `select('status')` alcanza, no hace falta el
    // documento completo solo para leer un campo.
    const actual = await ChannelOnboardingSession.findOne({ _id: sessionId, tenantId }).select('status');
    throw new InvalidSessionStateError(actual ? actual.status : 'desconocido');
  }

  return reclamada;
}

async function markSessionFailed(session, step, message) {
  session.status = 'failed';
  session.error = { step, message };
  await session.save();
}

// Shape de éxito compartido por /code, /callback y /complete-gupshup —
// nunca el documento completo, así ni por descuido puede viajar un
// token/secret acá. `extra` es para campos puntuales no sensibles que sí
// hace falta devolver (ej. embedSignupUrl en /complete-gupshup).
function respuestaSesion(res, session, { message, extra = {} } = {}) {
  return respuestaExito(res, {
    statusCode: 200,
    message,
    data: { sessionId: session._id, state: session.state, expiresAt: session.expiresAt, ...extra },
  });
}

function responderEstadoInvalido(res, err) {
  return respuestaError(res, {
    statusCode: 409,
    message: err.message,
    errors: { code: 'INVALID_SESSION_STATE', currentState: err.currentState },
  });
}

/**
 * @param {unknown} value
 * @returns {string|undefined} el string trimeado, o undefined si no vino
 *   nada (undefined/null/string vacío tras el trim) — nunca un string vacío.
 * @throws {AppError} 400 si vino pero no es string, o excede el máximo.
 */
function normalizarDisplayName(value) {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'string') {
    throw new AppError('displayName debe ser un texto', 400);
  }

  const trimmed = value.trim();
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new AppError(`displayName no puede superar los ${DISPLAY_NAME_MAX_LENGTH} caracteres`, 400);
  }

  return trimmed.length > 0 ? trimmed : undefined;
}

// ─── POST /api/v1/channels/whatsapp/embedded-signup/init ─────────────────────
// §19 del blueprint maestro. state/expiresAt/status/provider los autogenera
// el modelo por default (channelOnboardingSession.model.js) — no hace falta
// armarlos a mano acá.

const initEmbeddedSignup = async (req, res, next) => {
  try {
    const displayName = normalizarDisplayName(req.body?.displayName);

    // Concurrente a propósito (Decisión 8 del blueprint fase-2.1 / §20 del
    // blueprint maestro: N canales por tenant es el objetivo) — una sesión
    // sin terminar previa NUNCA bloquea una nueva, solo se deja registro
    // informativo (logger.info, nunca warn/error).
    const sesionesSinTerminar = await ChannelOnboardingSession.countDocuments({
      tenantId: req.businessId,
      status: { $in: ESTADOS_SIN_TERMINAR },
    });
    if (sesionesSinTerminar > 0) {
      logger.info('[channel.controller] Tenant con sesión(es) de onboarding sin terminar — se permite igual, concurrente', {
        tenantId: String(req.businessId),
        sesionesSinTerminar,
      });
    }

    const session = await ChannelOnboardingSession.create({
      tenantId: req.businessId,
      ...(displayName !== undefined ? { displayName } : {}),
    });

    if (!META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID) {
      // No bloquea la creación de la sesión (eso sí puede hacerlo este PR
      // sin la config) — pero el popup de Meta no va a poder iniciarse del
      // lado del frontend hasta que esta variable exista de verdad.
      logger.warn('[channel.controller] META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID no configurado — metaConfig.configId viaja null', {
        sessionId: String(session._id),
      });
    }

    logger.info('[channel.controller] Sesión de onboarding de WhatsApp iniciada', {
      tenantId: String(req.businessId),
      sessionId: String(session._id),
    });

    // Solo estos 4 campos, nunca el documento completo — ni por descuido
    // debe poder viajar acá un token/secret/dato de ChannelCredentials.
    return respuestaExito(res, {
      statusCode: 201,
      message: 'Sesión de onboarding de WhatsApp iniciada',
      data: {
        sessionId: session._id,
        state: session.state,
        expiresAt: session.expiresAt,
        metaConfig: {
          appId: META_APP_ID || null,
          configId: META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || null,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/channels/whatsapp/embedded-signup/code ─────────────────────
// §21 del blueprint maestro (Meta Callback, primer paso). Canjea el `code`
// que el SDK de Meta le entrega al frontend (vive solo 30s, contrato §2) por
// un access token — el frontend manda ESTO por separado del wabaId/
// phoneNumberId (que llegan por un canal postMessage distinto y sin
// garantía de timing exacto contra el `code`), justamente para no arriesgar
// que el `code` expire esperando el segundo evento.

const codeEmbeddedSignup = async (req, res, next) => {
  try {
    const { sessionId, code } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') throw new AppError('sessionId es requerido', 400);
    if (!code || typeof code !== 'string') throw new AppError('code es requerido', 400);

    let session;
    try {
      // Reclamo atómico (fix de idempotencia/race condition) — si 2 POST
      // /code llegan casi simultáneos para el mismo sessionId (reintento de
      // red por timeout, doble click), solo uno gana el `initiated` →
      // `exchanging_code` y sigue de acá para abajo; el otro tira
      // InvalidSessionStateError de una, sin haber llamado a Meta ni tocado
      // la sesión — no hay forma de que se pisen entre sí.
      session = await claimSessionForStep(sessionId, req.businessId, 'initiated', 'exchanging_code');
    } catch (err) {
      if (err instanceof InvalidSessionStateError) return responderEstadoInvalido(res, err);
      throw err;
    }

    let accessToken;
    try {
      accessToken = await metaEmbeddedSignup.exchangeCode(code);
    } catch (err) {
      await markSessionFailed(session, 'meta_auth', err.message);
      throw err;
    }

    // Cifrado con el mismo mecanismo AES-256-GCM/HKDF que ChannelCredentials
    // (channelCrypto.js) — el WhatsAppChannel real todavía no existe, se usa
    // el contexto sintético `onboarding:${session._id}` (ver el propio
    // modelo, channelOnboardingSession.model.js).
    session.meta.accessTokenCipher = channelCrypto.encrypt(accessToken, sessionCryptoContext(session));
    session.status = 'meta_authorized';
    await session.save();

    logger.info('[channel.controller] Code de Meta canjeado, sesión pasa a meta_authorized', {
      tenantId: String(req.businessId),
      sessionId: String(session._id),
    });

    // Nunca el token, ni cifrado — solo estos 3 campos.
    return respuestaSesion(res, session, { message: 'Autorización de Meta completada' });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/channels/whatsapp/embedded-signup/callback ─────────────────
// §21-22 del blueprint maestro (Meta Callback, segundo paso). Recibe
// wabaId/phoneNumberId (ya entregados por Meta vía postMessage al frontend,
// sin necesidad de ninguna llamada a la Graph API para resolverlos —
// contrato §2, confirmado), resuelve el phoneNumber real con el token
// descifrado del paso anterior, y deja la sesión lista para el registro en
// Gupshup — que NO ocurre acá, es PR-06 (complete-onboarding).

const callbackEmbeddedSignup = async (req, res, next) => {
  try {
    const { sessionId, wabaId, phoneNumberId, businessId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') throw new AppError('sessionId es requerido', 400);
    if (!wabaId || typeof wabaId !== 'string') throw new AppError('wabaId es requerido', 400);
    if (!phoneNumberId || typeof phoneNumberId !== 'string') throw new AppError('phoneNumberId es requerido', 400);
    // Business Manager (portafolio) elegido en el popup de Meta — OPCIONAL: el
    // evento FINISH del Embedded Signup lo trae, pero el frontend actual no lo
    // reenvía todavía. Si viene y es un ID numérico válido se conserva; si no, la
    // sesión sigue igual (nunca bloquea el onboarding por un dato informativo).
    const metaBusinessId = typeof businessId === 'string' && /^\d{5,30}$/.test(businessId) ? businessId : null;

    let session;
    try {
      // Mismo reclamo atómico que /code — 2 POST /callback concurrentes
      // para el mismo sessionId solo pueden avanzar uno de a la vez.
      session = await claimSessionForStep(sessionId, req.businessId, 'meta_authorized', 'resolving_number');
    } catch (err) {
      if (err instanceof InvalidSessionStateError) return responderEstadoInvalido(res, err);
      throw err;
    }

    if (!session.meta?.accessTokenCipher) {
      // No debería pasar nunca si el estado es meta_authorized — ese estado
      // solo se alcanza después de guardar el token cifrado en
      // codeEmbeddedSignup(). Fail-loud: es un estado inconsistente real,
      // no algo que reintentar /callback vaya a arreglar solo.
      throw new AppError(`Sesión ${session._id} en meta_authorized sin accessTokenCipher — estado inconsistente`, 500);
    }

    let accessToken;
    try {
      accessToken = channelCrypto.decrypt(session.meta.accessTokenCipher, sessionCryptoContext(session));
    } catch (err) {
      const wrapped = new AppError(`Sesión ${session._id}: token de Meta ilegible (${err.message})`, 500);
      await markSessionFailed(session, 'token_decryption', wrapped.message);
      throw wrapped;
    }

    let resolved;
    try {
      resolved = await metaEmbeddedSignup.resolvePhoneNumber(wabaId, phoneNumberId, accessToken);
    } catch (err) {
      await markSessionFailed(session, 'phone_resolution', err.message);
      throw err;
    }

    session.meta.wabaId = wabaId;
    session.meta.phoneNumberId = phoneNumberId;
    session.meta.phoneNumber = resolved.phoneNumber;
    if (metaBusinessId) session.meta.metaBusinessId = metaBusinessId;
    session.status = 'gupshup_registering';
    // Pasó el popup de Meta: la ventana de 30 min del init() ya cumplió su
    // función. Desde acá corre la fase de Gupshup (link válido 5 días).
    session.expiresAt = new Date(Date.now() + GUPSHUP_PHASE_WINDOW_MS);
    await session.save();

    logger.info('[channel.controller] WABA/número resueltos, sesión pasa a gupshup_registering', {
      tenantId: String(req.businessId),
      sessionId: String(session._id),
    });

    return respuestaSesion(res, session, { message: 'Datos de WhatsApp Business confirmados' });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/channels/whatsapp/embedded-signup/complete-gupshup ─────────
// PR-05 del blueprint maestro (§55, redefinido esta sesión — ver
// docs/integrations/gupshup-registration-contract.md §9), extendido en PR-06
// (§11) con la suscripción al webhook de eventos ACCOUNT. Registra la app de
// Gupshup para esta sesión (ya autorizada por Meta en PR-04, estado
// gupshup_registering), se suscribe a la Subscription API en modo ACCOUNT
// (necesario para que el webhook ACCOUNT_VERIFIED llegue después), y genera
// el link de embed signup real. NO crea WhatsAppChannel/ChannelCredentials
// acá — eso ocurre reactivamente cuando llega ese webhook, ver
// channelOnboardingCompletion.service.js.
//
// Usa GET .../onboarding/embed/link (partnerApps.getEmbedSignupLink) —
// confirmado como el endpoint correcto para altas 100% nuevas con 2
// fuentes independientes (un contacto humano de Gupshup + su Ask AI, ver
// el contrato doc §9). generateEmbedSignupLink()/verifyAndAttachCreditLine()
// (obotoembed/whitelist+verify) NO se usan acá — quedan reservados para un
// futuro caso de migración.

// Nombre determinístico de la PRIMERA app del tenant — vive en
// channelOnboardingApp.service.js junto con el resto de la selección de apps
// (una app independiente por conexión, ver ese archivo). Se re-exporta desde
// acá porque channelOnboardingCompletion.service.js y los tests ya lo importan
// de este módulo.
const nombreAppGupshup = channelOnboardingApp.nombreAppGupshup;

function isExpiredEmbedSignupLinkError(err) {
  const message = err instanceof Error ? err.message : String(err || '');
  return /link has expired,? please regenerate link/i.test(message);
}

const completeGupshupEmbeddedSignup = async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') throw new AppError('sessionId es requerido', 400);

    let session;
    try {
      // 'failed' se acepta también acá (a diferencia de /code y /callback)
      // porque un fallo transitorio de Gupshup en este paso es reintentable
      // sin rehacer el popup de Meta — pero solo si el fallo fue DE ESTE
      // paso (chequeo explícito abajo), no de un paso anterior de Meta.
      session = await loadSessionForStep(sessionId, req.businessId, ['gupshup_registering', 'failed']);
    } catch (err) {
      if (err instanceof InvalidSessionStateError) return responderEstadoInvalido(res, err);
      throw err;
    }

    if (session.status === 'failed' && session.error?.step !== 'gupshup_registration') {
      // Falló en un paso anterior (Meta) — ese SÍ requiere reiniciar desde
      // /init, no es este endpoint el que lo puede resolver.
      return responderEstadoInvalido(res, new InvalidSessionStateError('failed'));
    }

    // Un retry de Gupshup debe continuar la autorización Meta ya resuelta,
    // nunca iniciar silenciosamente otra incorporación con una sesión
    // incompleta o datos de otra ejecución.
    if (!session.meta?.wabaId || !session.meta?.phoneNumberId || !session.meta?.phoneNumber) {
      throw new AppError('La sesión no conserva una autorización Meta completa para continuar el onboarding', 409);
    }

    let token;
    try {
      token = await partnerAuth.getValidToken();

      // Una sesión que ya trae appId (retry, o sesión de código anterior) solo lo
      // conserva si sigue siendo seguro para ESTA conexión: una app ligada a
      // otro número, a un canal de otro número o a otro tenant se desvincula de
      // la sesión (la app en Gupshup no se toca) y se re-selecciona abajo.
      // Chequeo solo local (Mongo) — el estado remoto lo valida la selección de
      // una app NUEVA y, antes de activar nada, la conciliación/webhook (que exige
      // coincidencia de número).
      if (session.gupshup.appId) {
        const evaluacion = await channelOnboardingApp.evaluarAppLocal({
          appId: session.gupshup.appId, session, tenantId: req.businessId,
        });
        if (!evaluacion.seguro) {
          logger.warn('[channel.controller] App de la sesión no es segura para esta conexión — se desvincula y se selecciona otra', {
            tenantId: String(req.businessId),
            sessionId: String(session._id),
            appId: session.gupshup.appId,
            motivo: evaluacion.motivo,
          });
          await channelOnboardingApp.desvincularApp(session);
        }
      }

      if (!session.gupshup.appId) {
        // Incidente PR-11 (known-issues.md) + incidente de Nutriva (14/oct/2026):
        // reutiliza una app previa del mismo tenant SOLO si no está ligada a otro
        // número/tenant (local + GET waba/info); si no hay ninguna segura, crea una
        // app independiente para esta conexión. Ver channelOnboardingApp.service.js.
        await channelOnboardingApp.seleccionarOCrearApp({ session, tenantId: req.businessId, token });
      }

      if (!session.gupshup.webhookReference) {
        // Suscribe esta app al modo ACCOUNT de la Subscription API de
        // Gupshup — sin esto, el webhook ACCOUNT_VERIFIED que completa el
        // onboarding (PR-06, channelOnboardingCompletion.service.js) nunca
        // llega. Confirmado por fuente directa que hace falta el apikey DE
        // ESTA app (no el token de partner) — ver
        // docs/integrations/gupshup-registration-contract.md §11.
        //
        // Incidente del 04/sep/2026 (docs/implementation/known-issues.md,
        // Bug 3): la URL de callback es channelOnboardingWebhook.controller.js
        // (/gupshup/onboarding/:appId), DELIBERADAMENTE distinta de
        // /api/v1/webhooks/gupshup a secas — ese endpoint exige
        // GUPSHUP_WEBHOOK_TOKEN en todo POST (tráfico real de PLATFORM hoy,
        // no se toca) y el ping de verificación de Gupshup al crear la
        // suscripción no puede conocer ese secreto, causando el 400
        // "Invalid URL Passed" que bloqueaba este paso. El secreto de la
        // ruta nueva (GUPSHUP_ONBOARDING_WEBHOOK_TOKEN) viaja en `headers`
        // → Gupshup lo reenvía vía `meta` en cada request a esta URL.

        // Piloto PR-11 (docs/implementation/known-issues.md): MISMO patrón
        // que el chequeo de appId de arriba — si el appId se reusó de otra
        // sesión del mismo tenant, esa app puede YA tener una suscripción
        // activa con el tag determinístico ('creaos-account-events')
        // creada por esa sesión anterior. Sin este chequeo,
        // subscribeToEvents() (POST) vuelve a intentar crearla y Gupshup
        // responde 400 "Duplicate component tag."
        const sesionConWebhookExistente = await ChannelOnboardingSession.findOne({
          tenantId: req.businessId,
          _id: { $ne: session._id },
          'gupshup.appId': session.gupshup.appId,
          'gupshup.webhookReference': { $ne: null },
        }).sort({ createdAt: -1 }).select('gupshup.webhookReference');

        if (sesionConWebhookExistente) {
          session.gupshup.webhookReference = sesionConWebhookExistente.gupshup.webhookReference;
          await session.save();
        } else {
          if (!BACKEND_PUBLIC_URL) {
            throw new AppError('BACKEND_PUBLIC_URL no está configurado — no se puede suscribir el webhook de eventos ACCOUNT de Gupshup', 500);
          }
          if (!GUPSHUP_ONBOARDING_WEBHOOK_TOKEN) {
            throw new AppError('GUPSHUP_ONBOARDING_WEBHOOK_TOKEN no está configurado — no se puede suscribir el webhook de eventos ACCOUNT de Gupshup', 500);
          }

          const { apikey } = await partnerApps.getAppAccessToken(session.gupshup.appId, token);

          // Fallback (Gupshup): ninguna sesión en Mongo tenía el
          // webhookReference guardado (mismo caso borde de "creado afuera,
          // no persistido adentro" que el appId) — consultar si la app ya
          // tiene una suscripción activa con el tag determinístico antes
          // de intentar crear una nueva.
          const suscripciones = await partnerSubscriptions.getSubscriptions(session.gupshup.appId, apikey);
          const suscripcionExistente = suscripciones.find((s) => s.tag === 'creaos-account-events' && s.active);

          if (suscripcionExistente) {
            session.gupshup.webhookReference = GUPSHUP_ACCOUNT_SUBSCRIPTION_MARKER;
          } else {
            await partnerSubscriptions.subscribeToEvents(session.gupshup.appId, apikey, {
              url: `${BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup/onboarding/${session.gupshup.appId}`,
              tag: 'creaos-account-events',
              modes: ['ACCOUNT'],
              headers: { [ONBOARDING_WEBHOOK_HEADER]: GUPSHUP_ONBOARDING_WEBHOOK_TOKEN },
            });
            session.gupshup.webhookReference = GUPSHUP_ACCOUNT_SUBSCRIPTION_MARKER;
          }
          // Mismo criterio que appId arriba — se guarda antes de seguir,
          // así un retry no vuelve a pegarle a la Subscription API de más.
          await session.save();
        }
      }

      if (!session.gupshup.messagesWebhookReference) {
        // 06/sep/2026 (docs/implementation/known-issues.md): SEGUNDA
        // suscripción, independiente de la de ACCOUNT de arriba — sin esto,
        // Gupshup nunca reenvía los mensajes de WhatsApp entrantes reales a
        // nuestro webhook de mensajería (confirmado en vivo: los canales
        // DEDICATED de Nutriva Corp y "Negocio Prueba 3" tenían únicamente
        // la suscripción ACCOUNT — cero mensajes entregados jamás).
        //
        // Deliberadamente NO se fusiona con la suscripción de ACCOUNT de
        // arriba (mismo tag/url/modes): esa apunta al webhook DEDICADO de
        // onboarding (secreto propio, GUPSHUP_ONBOARDING_WEBHOOK_TOKEN, ver
        // el bloque de arriba), que no sabe procesar mensajes — mezclarlas
        // arriesgaría el flujo de Go-Live ya probado (PR #75/#76/#78/#81/
        // #82/#83) sin necesidad: Gupshup documenta hasta 5 suscripciones
        // por app.
        //
        // modes:['ALL'] en vez de un valor tipo 'MESSAGE': confirmado contra
        // la documentación oficial de Gupshup que ese endpoint (Partner API,
        // `partner.gupshup.io`) no tiene un valor "MESSAGE" en su
        // vocabulario (distinto al de la API self-serve vieja, que sí lo
        // tiene — ver partner.subscriptions.js) — 'ALL' sí es un valor
        // soportado, sin restricción de versión. gupshupProvider.js#
        // normalizeInboundEvent()/webhook.controller.js#gupshupWebhook() ya
        // ignoran en silencio cualquier evento que no sea `field:'messages'`
        // (o el account-event, interceptado aparte) — un modo más amplio no
        // tiene downside funcional, solo tráfico extra de webhook.
        //
        // Mismo patrón de idempotencia que el bloque de ACCOUNT de arriba
        // (PR-11, known-issues.md): reusar de otra sesión del mismo
        // tenant+appId, o de una suscripción ya activa en Gupshup, antes de
        // intentar crear una — así un reintento de este paso no choca con
        // "Duplicate component tag."
        const sesionConMessagesWebhookExistente = await ChannelOnboardingSession.findOne({
          tenantId: req.businessId,
          _id: { $ne: session._id },
          'gupshup.appId': session.gupshup.appId,
          'gupshup.messagesWebhookReference': { $ne: null },
        }).sort({ createdAt: -1 }).select('gupshup.messagesWebhookReference');

        if (sesionConMessagesWebhookExistente) {
          session.gupshup.messagesWebhookReference = sesionConMessagesWebhookExistente.gupshup.messagesWebhookReference;
          await session.save();
        } else {
          if (!BACKEND_PUBLIC_URL) {
            throw new AppError('BACKEND_PUBLIC_URL no está configurado — no se puede suscribir el webhook de mensajería de Gupshup', 500);
          }
          if (!GUPSHUP_WEBHOOK_TOKEN) {
            throw new AppError('GUPSHUP_WEBHOOK_TOKEN no está configurado — no se puede suscribir el webhook de mensajería de Gupshup', 500);
          }

          const { apikey } = await partnerApps.getAppAccessToken(session.gupshup.appId, token);

          const suscripciones = await partnerSubscriptions.getSubscriptions(session.gupshup.appId, apikey);
          const suscripcionExistente = suscripciones.find((s) => s.tag === GUPSHUP_MESSAGES_SUBSCRIPTION_TAG && s.active);

          if (suscripcionExistente) {
            session.gupshup.messagesWebhookReference = GUPSHUP_MESSAGES_SUBSCRIPTION_MARKER;
          } else {
            await partnerSubscriptions.subscribeToEvents(session.gupshup.appId, apikey, {
              url: `${BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup`,
              tag: GUPSHUP_MESSAGES_SUBSCRIPTION_TAG,
              modes: ['ALL'],
              // A diferencia del webhook de onboarding (arriba), este SÍ es
              // /api/v1/webhooks/gupshup a secas — el mismo que ya exige
              // GUPSHUP_WEBHOOK_TOKEN en todo POST real (webhook.service.js#
              // verifyGupshupAuth()) para el tráfico de PLATFORM hoy. Sin
              // pasar este header acá, Gupshup entregaría el evento sin él y
              // gupshupWebhook() lo rechazaría con 401 "Invalid credentials".
              headers: { [GUPSHUP_WEBHOOK_HEADER]: GUPSHUP_WEBHOOK_TOKEN },
            });
            session.gupshup.messagesWebhookReference = GUPSHUP_MESSAGES_SUBSCRIPTION_MARKER;
          }
          await session.save();
        }
      }

      await partnerApps.setContactDetails(
        session.gupshup.appId,
        { contactEmail: req.user.email, contactName: req.user.name, contactNumber: session.meta.phoneNumber },
        token
      );

      let link;
      try {
        ({ link } = await partnerApps.getEmbedSignupLink(
          session.gupshup.appId,
          { user: req.user.email, lang: 'es' },
          token
        ));
      } catch (err) {
        if (!isExpiredEmbedSignupLinkError(err)) throw err;

        // Gupshup conserva un único link por app y, al reutilizar el appId
        // determinístico del tenant, regenerate:false puede devolver el link
        // vencido de un onboarding anterior. Se permite UNA regeneración
        // explícita; si también falla, el catch exterior detiene el flujo y
        // deja el error recuperable, sin loops ni una tercera solicitud.
        logger.info('[channel.controller] Embed signup link vencido; se solicita una única regeneración', {
          tenantId: String(req.businessId),
          sessionId: String(session._id),
          appId: session.gupshup.appId,
        });
        ({ link } = await partnerApps.getEmbedSignupLink(
          session.gupshup.appId,
          { user: req.user.email, lang: 'es', regenerate: true },
          token
        ));
      }
      session.gupshup.embedSignupUrl = link;
      session.gupshup.embedSignupUrlGeneratedAt = new Date();

      // Si se llegó hasta acá reintentando desde 'failed' (chequeo de
      // arriba ya garantizó que ese fallo fue DE ESTE paso), el intento
      // actual tuvo éxito — se limpia el estado de error y se vuelve a
      // 'gupshup_registering'. Sin este reset, un retry exitoso dejaría la
      // sesión marcada 'failed' para siempre a pesar de haber funcionado.
      session.status = 'gupshup_registering';
      session.error = { step: null, message: null };
      // La ventana de 30 min del init() era solo para el popup de Meta; desde acá
      // la sesión vive lo que dura el link de Gupshup (5 días). Sin esto, la
      // expiración perezosa la marcaba `expired` (irrecuperable) en la próxima
      // lectura aunque la autorización de Meta y el link siguieran vigentes.
      session.expiresAt = new Date(Date.now() + GUPSHUP_PHASE_WINDOW_MS);
      // Link nuevo: el barrido automático de conciliación (worker) arranca su
      // calendario de reintentos de cero para esta sesión.
      session.reconcile = { ...RECONCILE_INITIAL_STATE };
      await session.save();
    } catch (err) {
      await markSessionFailed(session, 'gupshup_registration', err.message);
      throw err;
    }

    logger.info('[channel.controller] App de Gupshup registrada, embed signup link generado', {
      tenantId: String(req.businessId),
      sessionId: String(session._id),
      appId: session.gupshup.appId,
    });

    // Sigue en gupshup_registering — completar el canal real es PR-06.
    return respuestaSesion(res, session, {
      message: 'Link de registro de Gupshup generado',
      extra: { embedSignupUrl: session.gupshup.embedSignupUrl },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/channels/whatsapp/embedded-signup/reconcile ────────────────
// Conciliación contra el estado REAL de Gupshup (GET waba/info, solo lectura),
// para cuando el webhook ACCOUNT_VERIFIED no llega — ver
// channelOnboardingCompletion.service.js#reconcileOnboardingSession(). Un HTTP 200
// de ESTE endpoint NO significa canal activo: el estado lo dice `data.outcome`
// ('completed' | 'already_completed' son los únicos con canal conectado).
const MENSAJES_RECONCILE = {
  completed: 'Canal de WhatsApp conectado',
  already_completed: 'La sesión ya estaba completada',
  in_progress: 'Otra operación está terminando de configurar el canal — esperá un momento',
  pending: 'Gupshup todavía no confirma el número como activo',
  mismatch: 'La app de Gupshup está activa con un número distinto al autorizado — no se conectó ningún canal',
  not_ready: 'La sesión todavía no está lista para conciliarse',
  invalid_state: 'La sesión no está en un estado conciliable',
  stale: 'El link de Gupshup de esta sesión ya venció — hay que recuperarla o reiniciar el onboarding',
  app_unsafe: 'La app de Gupshup de esta sesión no es segura para este número — hay que recuperar la sesión',
  error: 'No se pudo consultar el estado en Gupshup — reintentá en unos minutos',
};

const reconcileEmbeddedSignup = async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') throw new AppError('sessionId es requerido', 400);
    if (!mongoose.isValidObjectId(sessionId)) throw new AppError('sessionId inválido', 400);

    const result = await completionService.reconcileOnboardingSession({ sessionId, tenantId: req.businessId });
    if (result.outcome === 'not_found') throw new AppError('Sesión de onboarding no encontrada', 404);

    return respuestaExito(res, {
      statusCode: 200,
      message: MENSAJES_RECONCILE[result.outcome] || 'Conciliación ejecutada',
      data: { sessionId, ...result },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/channels/whatsapp/embedded-signup/current ───────────────────
// Conexión de WhatsApp EN CURSO del tenant (autoservicio): fase + acción siguiente, para
// que el frontend la muestre y la retome tras recargar/cerrar la pestaña. Solo lectura y
// acotado por tenant. `data.onboarding` es null si no hay nada pendiente.
const getCurrentEmbeddedSignup = async (req, res, next) => {
  try {
    const onboarding = await channelOnboardingStatus.getCurrentOnboarding({ tenantId: req.businessId });
    return respuestaExito(res, {
      statusCode: 200,
      message: onboarding ? 'Conexión de WhatsApp en curso' : 'No hay una conexión de WhatsApp en curso',
      data: { onboarding },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/channels/whatsapp/embedded-signup/mode ──────────────────────
// Modo de onboarding de este negocio: 'gupshup_link' (una sola ventana, el enlace de Gupshup) si el interruptor global
// está activo y el negocio es nuevo (o está en la lista); si no, 'meta_then_link' (flujo clásico). El negocio sale del token.
const getOnboardingMode = async (req, res, next) => {
  try {
    const mode = (await channelOnboardingLink.modoEnlaceHabilitado(req.businessId)) ? 'gupshup_link' : 'meta_then_link';
    return respuestaExito(res, { statusCode: 200, message: 'Modo de onboarding de WhatsApp', data: { mode } });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/channels/whatsapp/embedded-signup/start ────────────────────
// Modo enlace único (informes 68/69): el cliente declara su número y CREA OS deja todo listo en Gupshup (app,
// callbacks, enlace firmado). Idempotente: repetir la solicitud devuelve la misma sesión/enlace. 404 si el modo no está
// activo para el negocio.
const startLinkOnboarding = async (req, res, next) => {
  try {
    const { phoneNumber, displayName } = req.body || {};
    const result = await channelOnboardingLink.startLinkOnboarding({
      tenantId: req.businessId,
      user: req.user,
      phoneNumber,
      displayName: normalizarDisplayName(displayName),
    });
    return respuestaExito(res, {
      statusCode: 200,
      message: result.inProgress ? 'La conexión se está preparando' : 'Enlace de conexión de WhatsApp listo',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/channels/whatsapp/embedded-signup/recover ──────────────────
// Reabre una sesión vencida o con la app insegura SIN repetir el popup de Meta (conserva
// la autorización ya otorgada). No llama a Meta ni a Gupshup: después el frontend vuelve
// a llamar a /complete-gupshup, que elige o crea una app segura y genera un enlace nuevo.
const recoverEmbeddedSignup = async (req, res, next) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') throw new AppError('sessionId es requerido', 400);
    if (!mongoose.isValidObjectId(sessionId)) throw new AppError('sessionId inválido', 400);

    const result = await channelOnboardingRecovery.recoverPendingSession({ sessionId, tenantId: req.businessId });
    return respuestaExito(res, {
      statusCode: 200,
      message: result.outcome === 'already_completed' ? 'La sesión ya estaba completada' : 'Sesión lista para continuar',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getOnboardingMode,
  startLinkOnboarding,
  getCurrentEmbeddedSignup,
  recoverEmbeddedSignup,
  initEmbeddedSignup,
  codeEmbeddedSignup,
  callbackEmbeddedSignup,
  completeGupshupEmbeddedSignup,
  reconcileEmbeddedSignup,
  // Exportada para PR-07a (channelOnboardingCompletion.service.js) — es la
  // MISMA función determinística usada acá para crear la app en Gupshup
  // (PR-05), reutilizada para poblar WhatsAppChannel.providerAccountId al
  // crear el canal DEDICATED real, en vez de duplicar la convención de
  // nombre en dos lugares.
  nombreAppGupshup,
  reassignConversationChannel,
  disconnectChannel,
  rotateChannelCredential,
  revokeChannelCredential,
};
