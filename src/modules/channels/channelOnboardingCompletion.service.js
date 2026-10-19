// channelOnboardingCompletion.service.js — PR-06 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md). Reacciona al
// webhook de Gupshup que confirma que el customer terminó el Embed Signup
// del lado de Gupshup: evento `account-event` con `status: ACCOUNT_VERIFIED`
// (Go-Live), entregado vía la Subscription API en modo ACCOUNT — suscripta
// para esta app en channel.controller.js#completeGupshupEmbeddedSignup()
// (PR-05, extendido en PR-06). Ver docs/integrations/gupshup-registration-
// contract.md §11 para el contrato completo, con fuentes.
//
// Incidente de Nutriva (14/oct/2026): este era el ÚNICO camino que creaba el
// canal, y dependía de un webhook que Gupshup no envía cuando la app ya estaba
// Live con otra WABA. Ahora hay un segundo camino, la conciliación
// (`reconcileOnboardingSession`), que consulta el estado REAL de la app en
// Gupshup (GET waba/info, solo lectura). Ambos caminos terminan en la MISMA
// función (`finalizarSesionReclamada`), con el mismo reclamo atómico (no pueden
// crear dos canales) y la misma regla: JAMÁS se activa un canal si el número
// verificado en Gupshup no es el que el cliente autorizó en Meta para esa sesión.
//
// NO es un handler HTTP — no recibe req/res. webhook.controller.js#gupshupWebhook()
// ya respondió el ACK 200 a Gupshup ANTES de llamar a handleGupshupAccountVerified()
// (mismo criterio que inboundGateway.handle() y processGupshupMessage() en
// ese mismo archivo) — cualquier error de este módulo se loguea, nunca se
// propaga a una respuesta HTTP que de todos modos ya se envió.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const channelCrypto = require('./channelCrypto');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const {
  nombreAppGupshup,
  telefonosCoinciden,
  normalizarTelefono,
  esAppNoLive,
  evaluarAppLocal,
  telefonoEsperado,
  esModoEnlace,
} = require('./channelOnboardingApp.service');
const logger = require('../../utils/logger');
const standardTemplateService = require('./standardTemplate.service');
const Conversation = require('../ai/conversation.model');

// El link de embed de Gupshup vale 5 días (contrato §7.3) — pasado eso la sesión
// ya no puede completarse sola y hay que recuperarla/reiniciarla. Margen de 2 días.
const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ¿Este payload de webhook es el evento de Go-Live (account-event /
 * ACCOUNT_VERIFIED)? Shape confirmado en docs/integrations/gupshup-
 * registration-contract.md §11.3 — mismo formato "v3" (`object` +
 * `entry[].changes[].field`) que ya sabe parsear el resto de
 * webhook.controller.js/webhook.service.js/gupshupProvider.js para mensajería,
 * solo que hasta PR-06 el valor `account-event` se descartaba en silencio en
 * los 3 lugares (`if (change.field !== 'messages') continue`).
 *
 * @param {object} payload - body crudo del webhook de Gupshup
 * @returns {boolean}
 */
function isAccountVerifiedEvent(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account') return false;
  const changes = payload.entry?.[0]?.changes || [];
  return changes.some(
    (change) => change.field === 'account-event' && change.value?.payload?.status === 'ACCOUNT_VERIFIED'
  );
}

async function markFailed(session, message) {
  session.status = 'failed';
  session.error = { step: 'channel_creation', message };
  await session.save();
  logger.error('[channelOnboardingCompletion] Error creando el canal real', {
    sessionId: String(session._id),
    error: message,
  });
}

/**
 * Crea (o recupera) el WhatsAppChannel DEDICATED + ChannelCredentials reales de
 * una sesión YA RECLAMADA (status 'completing', por el reclamo atómico de quien
 * llama) y la transiciona a 'completed'.
 *
 * Nunca activa un canal si el número que Gupshup tiene verificado para la app no
 * es el que el cliente autorizó en Meta para ESTA sesión (comparación por
 * teléfono, no por IDs: Meta entrega WABA/phoneNumberId provisorios que pueden
 * diferir de los definitivos de Gupshup, ver known-issues.md PR-11). En ese caso
 * devuelve la sesión a 'gupshup_registering' (sigue recuperable, datos de Meta y
 * token intactos) y devuelve `{ outcome: 'mismatch' }`.
 *
 * LIMITACIÓN CONOCIDA (identificada en el diseño de PR-06, no resuelta acá
 * a propósito): si falla a mitad de camino (ej. WhatsAppChannel se crea
 * pero ChannelCredentials falla), la sesión queda 'failed' (step
 * 'channel_creation'); handleGupshupAccountVerified() y la conciliación la
 * vuelven a reclamar, y el reintento reutiliza el canal ya creado.
 *
 * @param {import('./channelOnboardingSession.model')} session - ya en 'completing'
 * @param {{ via: 'webhook'|'reconcile', token?: string, apikey?: string, wabaInfo?: object }} opts
 *   token/apikey/wabaInfo opcionales: la conciliación ya los obtuvo para decidir
 *   y los pasa para no repetir llamadas a Gupshup (rate limit 10 req/60s).
 * @returns {Promise<{ outcome: 'completed', channelId: object }|{ outcome: 'mismatch', expected: string, found: string }>}
 */
async function finalizarSesionReclamada(session, { via, token: tokenPrevio, apikey: apikeyPrevio, wabaInfo: wabaInfoPrevio } = {}) {
  // Modo enlace único: no hay datos de Meta de CREA OS; la identidad esperada es el número declarado.
  const datosIncompletos = esModoEnlace(session) ? !session.declaredPhone : (!session.meta?.phoneNumber || !session.meta?.phoneNumberId);
  if (datosIncompletos) {
    // No debería pasar nunca en este estado — callbackEmbeddedSignup() (PR-04)
    // ya los deja seteados antes de avanzar a gupshup_registering. Fail-loud:
    // es un estado inconsistente real, no algo que un retry vaya a arreglar solo.
    const error = new Error(`Sesión ${session._id} en gupshup_registering sin phoneNumber/phoneNumberId — estado inconsistente`);
    await markFailed(session, error.message);
    throw error;
  }

  try {
    const token = tokenPrevio || await partnerAuth.getValidToken();
    const apikey = apikeyPrevio || (await partnerApps.getAppAccessToken(session.gupshup.appId, token)).apikey;

    // PR-11 (docs/implementation/known-issues.md): NO se usa
    // session.meta.phoneNumber/phoneNumberId/wabaId para el canal real —
    // son datos de Meta, cacheados en el momento en que ESTA sesión
    // puntual completó su propio popup, y pueden quedar obsoletos o
    // pertenecer a un intento distinto si el tenant reintentó el flujo más
    // de una vez. GET /partner/app/{appId}/waba/info es la fuente de verdad
    // de Gupshup sobre CUÁL es el número/WABA real y verificado para este
    // appId — el tenantId sí es seguro tomarlo de `session`.
    const wabaInfo = wabaInfoPrevio || await partnerApps.getWabaInfo(session.gupshup.appId, apikey);

    // Incidente de Nutriva (14/oct/2026): la fuente de verdad de Gupshup dice QUÉ
    // número tiene la app, pero ese número tiene que ser el que el cliente
    // autorizó para esta sesión. Si no coincide (típicamente: la app sigue Live
    // con el número anterior), activar el canal sería reconectar en silencio un
    // número que el cliente no pidió.
    if (!telefonosCoinciden(wabaInfo?.phone, telefonoEsperado(session))) {
      await ChannelOnboardingSession.updateOne(
        { _id: session._id, status: 'completing' },
        { $set: { status: 'gupshup_registering' } }
      );
      const found = wabaInfo?.phone ? `+${normalizarTelefono(wabaInfo.phone)}` : null;
      logger.warn('[channelOnboardingCompletion] El número verificado en Gupshup no coincide con el autorizado en Meta para esta sesión — no se activa ningún canal', {
        tenantId: String(session.tenantId),
        sessionId: String(session._id),
        appId: session.gupshup.appId,
        expected: telefonoEsperado(session),
        found,
        via,
      });
      return { outcome: 'mismatch', expected: telefonoEsperado(session), found };
    }

    let channel = await WhatsAppChannel.findOne({ provider: 'gupshup', phoneNumberId: wabaInfo.phoneId });
    if (channel && (String(channel.tenantId) !== String(session.tenantId) || String(channel.businessId) !== String(session.tenantId))) {
      throw new Error('El número verificado ya pertenece a otro tenant');
    }

    // Reconexión del MISMO número del MISMO tenant (autoservicio: el cliente lo
    // desconectó y lo vuelve a conectar). Como cada conexión usa su propia app de
    // Gupshup, el canal existente (disconnected/error/pending) puede estar ligado a
    // la app anterior: se RE-LIGA a la app nueva y se reemplazan sus credenciales
    // (las viejas pertenecen a la app anterior). Un canal ACTIVO servido por otra app
    // sí es un conflicto real y no se reasigna solo.
    const reconexion = Boolean(channel) && channel.status !== 'active';
    const cambiaDeApp = Boolean(channel && channel.providerAppId && channel.providerAppId !== session.gupshup.appId);
    if (cambiaDeApp && !reconexion) {
      throw new Error('El número verificado ya está asociado a otra aplicación de Gupshup de este tenant — no se reasigna automáticamente');
    }
    if (channel && reconexion) {
      channel.providerAppId = session.gupshup.appId;
      channel.providerAccountId = session.gupshup.appName || nombreAppGupshup(session.tenantId);
      channel.wabaId = wabaInfo.wabaId;
      channel.phoneNumber = `+${wabaInfo.phone}`;
      channel.webhookReference = session.gupshup.webhookReference;
      if (session.displayName) channel.displayName = session.displayName;
      // Provisorio igual que en un canal nuevo: recién se confirma 'partner' abajo.
      channel.outboundApi = 'legacy';
      channel.status = 'pending';
      channel.onboardingStatus = 'in_progress';
      await channel.save();
    }
    if (!channel) {
      channel = await WhatsAppChannel.create({
      tenantId: session.tenantId,
      businessId: session.tenantId,
      connectionType: 'DEDICATED',
      status: 'pending',
      onboardingStatus: 'in_progress',
      // PR2 (docs/implementation/known-issues.md, 07/sep/2026): 'legacy'
      // PROVISORIO acá a propósito — recién se confirma 'partner' más abajo
      // (junto con credentialsReference), DESPUÉS de que ChannelCredentials
      // también se haya creado con éxito. Si ese paso de abajo falla (ver la
      // "LIMITACIÓN CONOCIDA" de arriba: canal huérfano sin credenciales),
      // este canal NUNCA debe quedar marcado 'partner' sin tener el Partner
      // App Access Token realmente guardado — gupshupProvider.js#
      // resolveOutboundMode() trata 'partner' como una declaración de que
      // TODO está listo, no una intención a medias.
      outboundApi: 'legacy',
      phoneNumber: `+${wabaInfo.phone}`,
      phoneNumberId: wabaInfo.phoneId,
      wabaId: wabaInfo.wabaId,
      providerAppId: session.gupshup.appId,
      // El NOMBRE real de la app en Gupshup (no su GUID) — mismo campo que el
      // seed de PLATFORM puebla con GUPSHUP_APP_NAME. Sin esto, el envío saliente
      // por este canal no tiene forma de armar `src.name`. Desde que cada
      // conexión tiene su propia app, el nombre vive en la sesión
      // (gupshup.appName); las sesiones legacy no lo tienen y siguen cayendo al
      // nombre determinístico por tenant, que es con el que se crearon.
      providerAccountId: session.gupshup.appName || nombreAppGupshup(session.tenantId),
      webhookReference: session.gupshup.webhookReference,
      displayName: session.displayName,
      });
    }

    let credentials = await ChannelCredentials.findOne({ channel: channel._id, tenantId: session.tenantId, provider: 'gupshup' });
    if (!credentials) {
      credentials = await ChannelCredentials.create({
        channel: channel._id,
        tenantId: session.tenantId,
        provider: 'gupshup',
        apiKeys: [{ value: channelCrypto.encrypt(apikey, String(channel._id)) }],
      });
    } else if (cambiaDeApp || !credentials.apiKeys.some((entry) => !entry.revokedAt)) {
      // Reconexión: las keys vigentes (si quedaba alguna) son de la app anterior, y
      // las revocadas al desconectar no sirven — sin una key activa, resolveCredentials()
      // falla y el canal "conectado" no podría enviar. Se agrega la de la app actual.
      const ahora = new Date();
      if (cambiaDeApp) {
        for (const entry of credentials.apiKeys) {
          if (!entry.revokedAt) {
            entry.revokedAt = ahora;
            entry.revokedReason = 'channel_rebound_to_new_app';
          }
        }
      }
      credentials.apiKeys.push({ value: channelCrypto.encrypt(apikey, String(channel._id)) });
      await credentials.save();
    }

    channel.credentialsReference = credentials._id;
    // PR2: recién ACÁ se confirma 'partner' — providerAppId (arriba) y el
    // Partner App Access Token (ChannelCredentials, línea de arriba) están
    // AMBOS confirmados creados con éxito en este punto. Si esta línea
    // nunca se alcanza (ChannelCredentials.create() tiró), el canal quedó
    // con el 'legacy' provisorio de arriba — nunca 'partner' a medias.
    channel.outboundApi = 'partner';
    channel.status = 'active';
    channel.onboardingStatus = 'completed';
    await channel.save();

    if (reconexion) {
      // Al desconectar se marcaron las conversaciones del canal como "requieren
      // reasignación"; al reconectar el MISMO canal vuelven a estar operativas.
      await Conversation.updateMany(
        { business: session.tenantId, whatsappChannel: channel._id, whatsappChannelStatus: 'reassignment_required' },
        { $set: { whatsappChannelStatus: 'ready' } }
      );
    }

    // Un canal reutilizado en una reconexión ya está referenciado por la sesión de la primera
    // conexión (índice único en `channel`): esta sesión lo registra en `reusedChannel`.
    const yaReferenciado = reconexion && await ChannelOnboardingSession.exists({ channel: channel._id, _id: { $ne: session._id } });
    if (yaReferenciado) session.reusedChannel = channel._id;
    else session.channel = channel._id;
    session.status = 'completed';
    session.completedVia = via || null;
    session.error = { step: null, message: null };
    // El token de Meta ya no tiene ningún uso a partir de acá — ni Gupshup
    // ni ningún paso posterior lo necesitan (confirmado, ver
    // docs/integrations/gupshup-registration-contract.md §2/§9.4). Se limpia
    // por higiene SOLO al completar: mientras la sesión no esté completed, el
    // token cifrado, el sessionId y los IDs de Meta (wabaId, phoneNumberId,
    // businessId si vino) se conservan para poder recuperarla.
    session.meta.accessTokenCipher = null;
    await session.save();

    try {
      await standardTemplateService.ensureStandardTemplatesForChannel(channel._id, session.tenantId);
    } catch (templateError) {
      logger.warn('[channelOnboardingCompletion] Canal conectado; provisioning de plantillas pendiente', {
        tenantId: String(session.tenantId),
        channelId: String(channel._id),
        error: templateError.message,
      });
    }
    logger.info('[channelOnboardingCompletion] WhatsAppChannel DEDICATED creado, onboarding completado', {
      tenantId: String(session.tenantId),
      sessionId: String(session._id),
      channelId: String(channel._id),
      via,
    });
    return { outcome: 'completed', channelId: channel._id };
  } catch (err) {
    if (session.channel) {
      await WhatsAppChannel.updateOne(
        { _id: session.channel, tenantId: session.tenantId },
        { $set: { status: 'error', onboardingStatus: 'failed' } }
      ).catch(() => {});
    } else {
      await WhatsAppChannel.updateMany(
        { providerAppId: session.gupshup.appId, tenantId: session.tenantId, status: { $ne: 'active' } },
        { $set: { status: 'error', onboardingStatus: 'failed' } }
      ).catch(() => {});
    }
    await markFailed(session, err.message);
    throw err;
  }
}

/**
 * Camino 1 — webhook ACCOUNT_VERIFIED. Reclamo atómico (fix de idempotencia/race
 * condition — mismo patrón que outbound.worker.js:31-35 y
 * channel.controller.js#claimSessionForStep()): el `findOneAndUpdate` mueve la
 * sesión de 'gupshup_registering' a 'completing' en una sola operación atómica.
 * Si Gupshup reentrega el mismo webhook 2 veces casi simultáneas (entrega
 * at-least-once), solo UNA gana el reclamo; la otra hace no-op limpio SIN llamar a
 * Gupshup ni tocar la sesión.
 *
 * Nunca tira por casos sin acción posible (sesión inexistente, ya completada,
 * ya reclamada): son no-ops logueados. PR-11: con varias sesiones del mismo
 * tenant+appId en gupshup_registering se reclama la MÁS RECIENTE (`sort`).
 *
 * @param {string} gsAppId
 */
async function handleGupshupAccountVerified(gsAppId) {
  const session = await ChannelOnboardingSession.findOneAndUpdate(
    {
      'gupshup.appId': gsAppId,
      $or: [
        { status: 'gupshup_registering' },
        { status: 'failed', 'error.step': 'channel_creation' },
      ],
    },
    { $set: { status: 'completing' } },
    { new: true, sort: { createdAt: -1 } }
  );

  if (!session) {
    // Se relee (solo lectura, no forma parte del reclamo) para loguear con
    // precisión CUÁL de los 2 casos fue.
    const sesionExistente = await ChannelOnboardingSession.findOne({ 'gupshup.appId': gsAppId }).select('status');

    if (!sesionExistente) {
      logger.warn('[channelOnboardingCompletion] account-event sin ninguna ChannelOnboardingSession asociada', { gsAppId });
    } else {
      logger.info('[channelOnboardingCompletion] account-event para una sesión que ya no está en gupshup_registering (o ya la reclamó otra entrega concurrente del mismo webhook), no-op', {
        sessionId: String(sesionExistente._id),
        currentStatus: sesionExistente.status,
      });
    }
    return;
  }

  await finalizarSesionReclamada(session, { via: 'webhook' });
}

/**
 * Camino 2 — conciliación contra el estado REAL de Gupshup, sin depender del
 * webhook. Idempotente y segura:
 *  - SOLO lectura hasta decidir (token cacheado, apikey de la app, waba/info): un
 *    error transitorio de Gupshup NO muta la sesión (`outcome: 'error'`).
 *  - Activa únicamente si la app está Live (accountStatus ACTIVE) Y el número
 *    verificado es el autorizado en Meta para esta sesión. Un HTTP 200 de
 *    cualquier endpoint NO activa nada.
 *  - El reclamo atómico gupshup_registering → completing es el mismo que usa el
 *    webhook: webhook y conciliación concurrentes no pueden crear dos canales.
 *  - Siempre acotada por `tenantId` (una sesión de otro tenant es 'not_found').
 *  - No aplica la expiración perezosa de 30 min del popup de Meta: una app que
 *    quedó Live con el número correcto se completa aunque esa ventana haya vencido.
 *
 * @param {{ sessionId: string, tenantId: import('mongoose').Types.ObjectId|string }} params
 * @returns {Promise<{ outcome: string, [key: string]: any }>} outcome ∈ completed,
 *   already_completed, in_progress, pending, mismatch, identity_conflict, not_ready,
 *   invalid_state, stale, app_unsafe, not_found, error
 *   (`in_progress` también cuando la sesión está 'completing' por un webhook concurrente)
 *   (solo `completed` activa un canal; `pending`/`error`/`in_progress` son esperas)
 */
async function reconcileOnboardingSession({ sessionId, tenantId }) {
  const session = await ChannelOnboardingSession.findOne({ _id: sessionId, tenantId });
  if (!session) return { outcome: 'not_found' };

  if (session.status === 'completed') return { outcome: 'already_completed', channelId: session.channel || session.reusedChannel || null };

  // 'completing' = otro actor (el webhook ACCOUNT_VERIFIED u otra conciliación) ya
  // reclamó la sesión y la está terminando. No es un estado inválido ni terminal: es
  // una espera. Se reintenta después — si ese actor falla, la sesión vuelve a
  // 'gupshup_registering' (número distinto) o queda 'failed'/'channel_creation', ambos
  // conciliables. Esta rama NO activa nada ni toca la sesión.
  if (session.status === 'completing') return { outcome: 'in_progress' };

  const reconciliable = session.status === 'gupshup_registering'
    || (session.status === 'failed' && session.error?.step === 'channel_creation');
  if (!reconciliable) return { outcome: 'invalid_state', status: session.status };

  if (!session.gupshup?.appId) return { outcome: 'not_ready', reason: 'sin_app_de_gupshup' };
  if (!telefonoEsperado(session)) return { outcome: 'not_ready', reason: 'sin_telefono_autorizado_en_meta' };

  const referencia = session.gupshup.embedSignupUrlGeneratedAt || session.updatedAt;
  if (referencia && Date.now() - new Date(referencia).getTime() > RECONCILE_MAX_AGE_MS) {
    return { outcome: 'stale' };
  }

  // Aislamiento: si la app figura en un canal/sesión de otro tenant o está ligada a
  // otro número del mismo tenant, esta sesión NO puede completarse con ella.
  const local = await evaluarAppLocal({ appId: session.gupshup.appId, session, tenantId });
  if (!local.seguro) return { outcome: 'app_unsafe', reason: local.motivo };

  let token;
  let apikey;
  let wabaInfo;
  try {
    token = await partnerAuth.getValidToken();
    ({ apikey } = await partnerApps.getAppAccessToken(session.gupshup.appId, token));
    wabaInfo = await partnerApps.getWabaInfo(session.gupshup.appId, apikey);
  } catch (err) {
    if (esAppNoLive(err)) return { outcome: 'pending' };
    logger.warn('[channelOnboardingCompletion] Conciliación: no se pudo leer el estado de la app en Gupshup (sin cambios en la sesión)', {
      tenantId: String(tenantId), sessionId: String(session._id), error: err.message,
    });
    return {
      outcome: 'error',
      message: err.message,
      statusCode: err.statusCode || null,
      // Cuota local del Partner API (partnerRateLimit.js): no hubo solicitud a Gupshup.
      code: err.code || null,
      retryAfterMs: err.retryAfterMs ?? null,
    };
  }

  // Información insuficiente o estado distinto de ACTIVE → la sesión se mantiene
  // pendiente (sin mutarla), con el motivo para el diagnóstico. Un HTTP 200 sin
  // datos de WABA nunca activa nada.
  if (!wabaInfo || !wabaInfo.phone) return { outcome: 'pending', reason: 'informacion_insuficiente' };
  if (String(wabaInfo.accountStatus || '').toUpperCase() !== 'ACTIVE') {
    return { outcome: 'pending', reason: 'estado_no_activo', accountStatus: wabaInfo.accountStatus || null, dockerStatus: wabaInfo.dockerStatus || null };
  }
  // Sin los IDs definitivos de Gupshup no hay con qué crear un canal enrutable.
  if (!wabaInfo.wabaId || !wabaInfo.phoneId) return { outcome: 'pending', reason: 'informacion_insuficiente' };

  if (!telefonosCoinciden(wabaInfo.phone, telefonoEsperado(session))) {
    logger.warn('[channelOnboardingCompletion] Conciliación: la app está Live con un número distinto al autorizado — no se activa ningún canal', {
      tenantId: String(tenantId), sessionId: String(session._id), appId: session.gupshup.appId,
      expected: telefonoEsperado(session), found: `+${normalizarTelefono(wabaInfo.phone)}`,
    });
    return { outcome: 'mismatch', expected: telefonoEsperado(session), found: `+${normalizarTelefono(wabaInfo.phone)}` };
  }

  // Identidad entre tenants: ni la WABA ni el número verificados pueden figurar en
  // un canal de OTRO tenant. Se corta ANTES de reclamar la sesión, así no queda
  // mutada ni 'failed' — queda pendiente para que alguien la revise.
  const ajeno = await WhatsAppChannel.exists({
    provider: 'gupshup',
    tenantId: { $ne: tenantId },
    $or: [{ phoneNumberId: wabaInfo.phoneId }, { wabaId: wabaInfo.wabaId }],
  });
  if (ajeno) {
    logger.warn('[channelOnboardingCompletion] Conciliación: la WABA o el número verificados ya pertenecen a otro tenant — no se activa ningún canal', {
      tenantId: String(tenantId), sessionId: String(session._id), appId: session.gupshup.appId,
    });
    return { outcome: 'identity_conflict', reason: 'waba_o_numero_de_otro_tenant' };
  }

  // La WABA que entregó el popup de Meta puede diferir de la definitiva de Gupshup
  // (documentado como esperado, known-issues.md): el ancla de identidad es
  // tenant + appId + número exacto. Se deja constancia cuando difieren.
  if (session.meta.wabaId && session.meta.wabaId !== wabaInfo.wabaId) {
    logger.info('[channelOnboardingCompletion] Conciliación: la WABA definitiva de Gupshup difiere de la provisoria del popup de Meta (esperado)', {
      tenantId: String(tenantId), sessionId: String(session._id), metaWabaId: session.meta.wabaId, gupshupWabaId: wabaInfo.wabaId,
    });
  }

  const reclamada = await ChannelOnboardingSession.findOneAndUpdate(
    {
      _id: session._id,
      tenantId,
      $or: [
        { status: 'gupshup_registering' },
        { status: 'failed', 'error.step': 'channel_creation' },
      ],
    },
    { $set: { status: 'completing' } },
    { new: true }
  );
  if (!reclamada) return { outcome: 'in_progress' };

  return finalizarSesionReclamada(reclamada, { via: 'reconcile', token, apikey, wabaInfo });
}

module.exports = {
  handleGupshupAccountVerified,
  reconcileOnboardingSession,
  isAccountVerifiedEvent,
  RECONCILE_MAX_AGE_MS,
};
