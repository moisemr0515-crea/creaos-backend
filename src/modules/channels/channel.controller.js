// channel.controller.js — handlers HTTP del módulo channels/ (primera vez
// que expone rutas propias). PR-03 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §19-20): SOLO el
// endpoint de init del Embedded Signup. El callback de Meta (§21, PR-04) y
// cualquier llamada real a Gupshup Partner API (createApp() y el resto,
// PR-05+) todavía no existen — esta sesión se completa recién en esos PRs.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const channelCrypto = require('./channelCrypto');
const metaEmbeddedSignup = require('./providers/meta/metaEmbeddedSignup.service');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito, respuestaError } = require('../../utils/response');
const logger = require('../../utils/logger');
const { META_APP_ID, META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID, BACKEND_PUBLIC_URL, GUPSHUP_ONBOARDING_WEBHOOK_TOKEN } = require('../../config/env');
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
    const { sessionId, wabaId, phoneNumberId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') throw new AppError('sessionId es requerido', 400);
    if (!wabaId || typeof wabaId !== 'string') throw new AppError('wabaId es requerido', 400);
    if (!phoneNumberId || typeof phoneNumberId !== 'string') throw new AppError('phoneNumberId es requerido', 400);

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
    session.status = 'gupshup_registering';
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

const APP_NAME_PREFIX = 'creaos';

// Determinístico: el mismo tenant siempre pide el mismo nombre de app — un
// retry de createApp() choca con 409 "Bot Already Exists" en vez de crear
// una app duplicada. Puro alfanumérico a propósito: el guion cuenta como
// "carácter especial" y Gupshup lo rechaza (confirmado en vivo en PR-02) —
// el tenantId (ObjectId, 24 hex) ya lo garantiza sin necesitar separadores.
//
// LIMITACIÓN CONOCIDA (identificada en el diseño de PR-06, no arreglada a
// propósito — decisión explícita, no un descuido): el nombre depende SOLO de
// tenantId, no de la sesión. initEmbeddedSignup() permite a propósito varias
// ChannelOnboardingSession concurrentes sin terminar por tenant (Decisión 8
// del blueprint). Si el mismo tenant tiene 2 sesiones concurrentes que
// ambas llegan a este paso, la segunda en llamar createApp() va a chocar con
// 409 "Bot Already Exists" (mapeado normalmente por partner.errors.js) —
// solo la primera puede completar el registro de Gupshup para ese tenant a
// la vez. No bloqueante para PR-06 (una sola sesión activa por tenant es el
// caso normal), pero documentado para no reintroducir esta pregunta más
// adelante sin contexto.
function nombreAppGupshup(tenantId) {
  return `${APP_NAME_PREFIX}${tenantId}`;
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

    let token;
    try {
      token = await partnerAuth.getValidToken();

      if (!session.gupshup.appId) {
        const { appId } = await partnerApps.createApp({ name: nombreAppGupshup(req.businessId) }, token);
        session.gupshup.appId = appId;
        // Se guarda ANTES de seguir — si algo de acá para abajo falla, un
        // retry no vuelve a crear la app (ver el chequeo `if` de arriba).
        await session.save();
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
        if (!BACKEND_PUBLIC_URL) {
          throw new AppError('BACKEND_PUBLIC_URL no está configurado — no se puede suscribir el webhook de eventos ACCOUNT de Gupshup', 500);
        }
        if (!GUPSHUP_ONBOARDING_WEBHOOK_TOKEN) {
          throw new AppError('GUPSHUP_ONBOARDING_WEBHOOK_TOKEN no está configurado — no se puede suscribir el webhook de eventos ACCOUNT de Gupshup', 500);
        }

        const { apikey } = await partnerApps.getAppAccessToken(session.gupshup.appId, token);
        await partnerSubscriptions.subscribeToEvents(session.gupshup.appId, apikey, {
          url: `${BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup/onboarding/${session.gupshup.appId}`,
          tag: 'creaos-account-events',
          modes: ['ACCOUNT'],
          headers: { [ONBOARDING_WEBHOOK_HEADER]: GUPSHUP_ONBOARDING_WEBHOOK_TOKEN },
        });
        session.gupshup.webhookReference = GUPSHUP_ACCOUNT_SUBSCRIPTION_MARKER;
        // Mismo criterio que appId arriba — se guarda antes de seguir, así
        // un retry no vuelve a pegarle a la Subscription API de más.
        await session.save();
      }

      await partnerApps.setContactDetails(
        session.gupshup.appId,
        { contactEmail: req.user.email, contactName: req.user.name, contactNumber: session.meta.phoneNumber },
        token
      );

      const { link } = await partnerApps.getEmbedSignupLink(session.gupshup.appId, { user: req.user.email, lang: 'es' }, token);
      session.gupshup.embedSignupUrl = link;
      session.gupshup.embedSignupUrlGeneratedAt = new Date();

      // Si se llegó hasta acá reintentando desde 'failed' (chequeo de
      // arriba ya garantizó que ese fallo fue DE ESTE paso), el intento
      // actual tuvo éxito — se limpia el estado de error y se vuelve a
      // 'gupshup_registering'. Sin este reset, un retry exitoso dejaría la
      // sesión marcada 'failed' para siempre a pesar de haber funcionado.
      session.status = 'gupshup_registering';
      session.error = { step: null, message: null };
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

module.exports = {
  initEmbeddedSignup,
  codeEmbeddedSignup,
  callbackEmbeddedSignup,
  completeGupshupEmbeddedSignup,
  // Exportada para PR-07a (channelOnboardingCompletion.service.js) — es la
  // MISMA función determinística usada acá para crear la app en Gupshup
  // (PR-05), reutilizada para poblar WhatsAppChannel.providerAccountId al
  // crear el canal DEDICATED real, en vez de duplicar la convención de
  // nombre en dos lugares.
  nombreAppGupshup,
};
