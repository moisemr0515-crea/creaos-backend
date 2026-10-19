// channelOnboardingLink.service.js — «modo enlace único» del onboarding de WhatsApp (informes 68/69).
//
// Flujo clásico: ventana de Meta de CREA OS → enlace de Gupshup (SEGUNDA ventana). Este modo elimina la primera: el
// cliente declara su número, CREA OS crea la app con la Partner Onboarding API, deja listos los callbacks y genera el
// enlace firmado de Gupshup, que es la ÚNICA autorización de Meta. La activación la siguen haciendo el webhook
// ACCOUNT_VERIFIED y la conciliación (channelOnboardingCompletion / ReconcileSweep), que solo activan un canal si
// Gupshup confirma que la app está Live con el MISMO número que declaró el cliente.
//
// Alcance: SOLO Partner Onboarding APIs con el JWT de socio (POST /partner/app, PUT onboarding/contact, Subscription
// API, GET onboarding/embed/link). No usa Bizgate, Universal Tokens, tpp/app ni las APIs de vinculación por App ID +
// API key (la que Gupshup descontinúa el 31-oct-2026; ver informe 69). DESACTIVADO por defecto
// (ONBOARDING_LINK_MODE_ENABLED); con el interruptor apagado ningún comportamiento existente cambia.
//
// Garantías: aislamiento por tenant en cada consulta; idempotente (misma solicitud = misma sesión, misma app, mismo
// enlace); un arrendamiento atómico impide que dos solicitudes simultáneas ejecuten los pasos de Gupshup a la vez; la
// app se guarda en la sesión ANTES de seguir, así un reintento nunca crea otra; no escribe nada en canales existentes.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const Business = require('../businesses/business.model');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const channelOnboardingApp = require('./channelOnboardingApp.service');
const channelOnboardingStatus = require('./channelOnboardingStatus.service');
const { ONBOARDING_WEBHOOK_HEADER } = require('./channelOnboardingWebhook.constants');
const env = require('../../config/env');
const { AppError } = require('../../middleware/error.middleware');
const logger = require('../../utils/logger');

const { GUPSHUP_PHASE_WINDOW_MS, RECONCILE_INITIAL_STATE } = ChannelOnboardingSession;

// Mismos marcadores/etiquetas que el flujo clásico (channel.controller.js): las suscripciones son las mismas.
const ACCOUNT_TAG = 'creaos-account-events';
const ACCOUNT_MARKER = 'gupshup:account-subscribed';
const MESSAGES_TAG = 'creaos-messages';
const MESSAGES_MARKER = 'gupshup:messages-subscribed';

const LEASE_MS = 90 * 1000; // un POST /start no debería tardar más; si el proceso muere, el arrendamiento caduca solo
const ENLACE_MARGEN_MS = 60 * 60 * 1000; // se pide un enlace nuevo si al actual le queda menos de 1 h
const REUTILIZABLES = ['gupshup_registering', 'failed'];

/**
 * ¿Usa el modo enlace único este negocio? Apagado por defecto.
 *  1. Interruptor global (ONBOARDING_LINK_MODE_ENABLED) apagado → NO, para todos (parada de emergencia).
 *  2. Negocio en la lista explícita (ONBOARDING_LINK_MODE_TENANTS) → SÍ.
 *  3. Negocio registrado en o después de ONBOARDING_LINK_MODE_NEW_TENANTS_FROM → SÍ, automáticamente.
 *  4. Cualquier otro (negocios existentes) → NO: conservan el flujo clásico.
 * La fecha de registro se lee SIEMPRE del negocio del token (nunca de la solicitud), así que un cliente no puede elegir
 * el modo de otro ni el suyo.
 */
async function modoEnlaceHabilitado(tenantId) {
  if (!env.ONBOARDING_LINK_MODE_ENABLED) return false;
  if ((env.ONBOARDING_LINK_MODE_TENANTS || []).includes(String(tenantId))) return true;
  const desde = env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM;
  if (!desde) return false;
  const negocio = await Business.findById(tenantId).select('createdAt').lean();
  return Boolean(negocio?.createdAt && negocio.createdAt.getTime() >= desde.getTime());
}

/**
 * El cliente debe escribir el número con código de país («+51…»): no se adivina el país (la normalización genérica de
 * CREA OS asume Perú y aquí equivocarse activaría un canal con el número equivocado).
 */
function normalizarTelefonoDeclarado(value) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('phoneNumber es requerido', 400);
  const limpio = value.trim().replace(/[\s().-]/g, '');
  if (!limpio.startsWith('+')) {
    throw new AppError('Escribe el número de WhatsApp con el código de país (por ejemplo +51 900 000 000)', 400);
  }
  if (!/^\+[1-9]\d{7,14}$/.test(limpio)) throw new AppError('El número de WhatsApp no es válido', 400);
  return limpio;
}

// El número no puede estar ya conectado: ni en este negocio (activo) ni en otro. El mensaje no revela de quién es.
async function asegurarNumeroDisponible({ tenantId, declaredPhone }) {
  const canales = await WhatsAppChannel.find({
    phoneNumber: { $in: [declaredPhone, declaredPhone.slice(1)] },
  }).select('tenantId status').lean();
  for (const canal of canales) {
    if (String(canal.tenantId) !== String(tenantId)) {
      throw new AppError('Este número no puede conectarse a este negocio', 409);
    }
    if (canal.status === 'active') throw new AppError('Este número ya está conectado', 409);
  }
}

function filtroReutilizable({ tenantId, declaredPhone, now }) {
  return {
    tenantId,
    mode: 'gupshup_link',
    declaredPhone,
    expiresAt: { $gt: now },
    $or: [{ status: 'gupshup_registering' }, { status: 'failed', 'error.step': { $in: ['gupshup_registration', 'channel_creation'] } }],
  };
}

// Misma solicitud (mismo negocio y número) = misma sesión. La unicidad la garantiza la BASE DE DATOS, sin índices nuevos:
// `state` ya es único, y aquí se deriva del negocio, el número y el número de intento. Dos solicitudes simultáneas calculan
// el mismo intento, intentan crear el mismo `state` y solo una lo logra; la otra recibe el error de clave duplicada y
// retoma la sesión ganadora. (Elegir «la más antigua» después de crear NO es seguro: createdAt no sigue el orden de
// escritura y dos solicitudes pueden quedarse cada una con su sesión.)
const stateDeEnlace = (tenantId, declaredPhone, intento) => `lnk:${tenantId}:${declaredPhone.slice(1)}:${intento}`;

async function obtenerOCrearSesion({ tenantId, declaredPhone, displayName, now }) {
  const filtro = filtroReutilizable({ tenantId, declaredPhone, now });
  // El conteo va ANTES de la búsqueda: toda sesión visible al contar también lo es al buscar.
  const intento = await ChannelOnboardingSession.countDocuments({ tenantId, mode: 'gupshup_link', declaredPhone });

  const existente = await ChannelOnboardingSession.findOne(filtro).sort({ createdAt: -1 });
  if (existente) return { session: existente, creada: false };

  try {
    const nueva = await ChannelOnboardingSession.create({
      tenantId,
      mode: 'gupshup_link',
      declaredPhone,
      state: stateDeEnlace(tenantId, declaredPhone, intento),
      status: 'gupshup_registering',
      expiresAt: new Date(now.getTime() + GUPSHUP_PHASE_WINDOW_MS),
      ...(displayName ? { displayName } : {}),
    });
    return { session: nueva, creada: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const ganadora = await ChannelOnboardingSession.findOne(filtro).sort({ createdAt: -1 });
    if (!ganadora) throw new AppError('Ya hay una conexión en preparación para este número; inténtalo de nuevo en unos segundos', 409);
    return { session: ganadora, creada: false };
  }
}

// Arrendamiento atómico: solo UNA solicitud ejecuta los pasos de Gupshup para una sesión a la vez.
function tomarArrendamiento(sessionId, now) {
  return ChannelOnboardingSession.findOneAndUpdate(
    {
      _id: sessionId,
      status: { $in: REUTILIZABLES },
      $or: [{ startLeaseUntil: null }, { startLeaseUntil: { $lte: now } }],
    },
    { $set: { startLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { new: true }
  );
}

function liberarArrendamiento(sessionId) {
  return ChannelOnboardingSession.updateOne({ _id: sessionId }, { $set: { startLeaseUntil: null } }).catch(() => {});
}

async function marcarFallida(session, mensaje) {
  session.status = 'failed';
  session.error = { step: 'gupshup_registration', message: String(mensaje || '').slice(0, 400) };
  await session.save().catch(() => {});
}

// Suscribe la app a ACCOUNT (activación) y ALL (mensajes), reutilizando lo que ya exista: nunca duplica etiquetas.
async function asegurarSuscripciones(session, token) {
  const tenantId = session.tenantId;
  const appId = session.gupshup.appId;

  const pendientes = [];
  if (!session.gupshup.webhookReference) pendientes.push('account');
  if (!session.gupshup.messagesWebhookReference) pendientes.push('messages');
  if (pendientes.length === 0) return;

  if (!env.BACKEND_PUBLIC_URL) throw new AppError('BACKEND_PUBLIC_URL no está configurado — no se pueden suscribir los webhooks de Gupshup', 500);
  if (pendientes.includes('account') && !env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN) {
    throw new AppError('GUPSHUP_ONBOARDING_WEBHOOK_TOKEN no está configurado — no se puede suscribir el webhook de eventos ACCOUNT de Gupshup', 500);
  }
  if (pendientes.includes('messages') && !env.GUPSHUP_WEBHOOK_TOKEN) {
    throw new AppError('GUPSHUP_WEBHOOK_TOKEN no está configurado — no se puede suscribir el webhook de mensajería de Gupshup', 500);
  }

  // Misma app reutilizada por otra sesión del mismo negocio: heredar la referencia en vez de volver a suscribir.
  const hermana = await ChannelOnboardingSession.findOne({
    tenantId, _id: { $ne: session._id }, 'gupshup.appId': appId,
  }).sort({ createdAt: -1 }).select('gupshup.webhookReference gupshup.messagesWebhookReference').lean();
  if (pendientes.includes('account') && hermana?.gupshup?.webhookReference) session.gupshup.webhookReference = hermana.gupshup.webhookReference;
  if (pendientes.includes('messages') && hermana?.gupshup?.messagesWebhookReference) session.gupshup.messagesWebhookReference = hermana.gupshup.messagesWebhookReference;

  const faltaAccount = !session.gupshup.webhookReference;
  const faltaMessages = !session.gupshup.messagesWebhookReference;
  if (faltaAccount || faltaMessages) {
    const { apikey } = await partnerApps.getAppAccessToken(appId, token);
    const existentes = await partnerSubscriptions.getSubscriptions(appId, apikey);

    if (faltaAccount) {
      if (!existentes.some((s) => s.tag === ACCOUNT_TAG && s.active)) {
        await partnerSubscriptions.subscribeToEvents(appId, apikey, {
          url: `${env.BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup/onboarding/${appId}`,
          tag: ACCOUNT_TAG,
          modes: ['ACCOUNT'],
          headers: { [ONBOARDING_WEBHOOK_HEADER]: env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN },
        });
      }
      session.gupshup.webhookReference = ACCOUNT_MARKER;
      await session.save(); // antes de seguir: un reintento no vuelve a suscribir
    }
    if (faltaMessages) {
      if (!existentes.some((s) => s.tag === MESSAGES_TAG && s.active)) {
        await partnerSubscriptions.subscribeToEvents(appId, apikey, {
          url: `${env.BACKEND_PUBLIC_URL}/api/v1/webhooks/gupshup`,
          tag: MESSAGES_TAG,
          modes: ['ALL'],
          headers: { [env.GUPSHUP_WEBHOOK_HEADER]: env.GUPSHUP_WEBHOOK_TOKEN },
        });
      }
      session.gupshup.messagesWebhookReference = MESSAGES_MARKER;
      await session.save();
    }
  } else {
    await session.save();
  }
}

const esEnlaceVencido = (err) => /link has expired,? please regenerate link/i.test(err instanceof Error ? err.message : String(err || ''));

function enlaceVigente(session, now) {
  const generado = session.gupshup?.embedSignupUrlGeneratedAt;
  if (!session.gupshup?.embedSignupUrl || !generado) return false;
  return now.getTime() - new Date(generado).getTime() < GUPSHUP_PHASE_WINDOW_MS - ENLACE_MARGEN_MS;
}

// Pasos de Gupshup, todos idempotentes y persistidos uno a uno.
async function prepararAppYEnlace({ session, user, token, now }) {
  const tenantId = session.tenantId;

  // Una app que ya trae la sesión solo se conserva si sigue siendo segura para ESTA conexión (otro negocio/otro número).
  if (session.gupshup.appId) {
    const evaluacion = await channelOnboardingApp.evaluarAppLocal({ appId: session.gupshup.appId, session, tenantId });
    if (!evaluacion.seguro) {
      logger.warn('[channelOnboardingLink] App de la sesión no es segura para esta conexión — se desvincula y se selecciona otra', {
        tenantId: String(tenantId), sessionId: String(session._id), appId: session.gupshup.appId, motivo: evaluacion.motivo,
      });
      await channelOnboardingApp.desvincularApp(session);
    }
  }
  if (!session.gupshup.appId) {
    await channelOnboardingApp.seleccionarOCrearApp({ session, tenantId, token });
  }

  await asegurarSuscripciones(session, token);

  if (enlaceVigente(session, now)) {
    if (session.status === 'failed') { // un reintento exitoso no debe dejar la sesión marcada como fallida
      session.status = 'gupshup_registering';
      session.error = { step: null, message: null };
      await session.save();
    }
    return { enlaceNuevo: false };
  }

  await partnerApps.setContactDetails(
    session.gupshup.appId,
    { contactEmail: user?.email, contactName: user?.name, contactNumber: session.declaredPhone },
    token
  );

  const consulta = { user: user?.email, lang: 'es' };
  let link;
  if (session.gupshup.embedSignupUrl) {
    // Había uno y ya (casi) venció: una regeneración explícita.
    ({ link } = await partnerApps.getEmbedSignupLink(session.gupshup.appId, { ...consulta, regenerate: true }, token));
  } else {
    try {
      ({ link } = await partnerApps.getEmbedSignupLink(session.gupshup.appId, consulta, token));
    } catch (err) {
      if (!esEnlaceVencido(err)) throw err;
      ({ link } = await partnerApps.getEmbedSignupLink(session.gupshup.appId, { ...consulta, regenerate: true }, token));
    }
  }

  session.gupshup.embedSignupUrl = link;
  session.gupshup.embedSignupUrlGeneratedAt = new Date();
  session.status = 'gupshup_registering';
  session.error = { step: null, message: null };
  session.expiresAt = new Date(Date.now() + GUPSHUP_PHASE_WINDOW_MS);
  session.reconcile = { ...RECONCILE_INITIAL_STATE }; // enlace nuevo: el barrido arranca su calendario de cero
  await session.save();
  return { enlaceNuevo: true };
}

/**
 * Inicia (o retoma, de forma idempotente) la conexión de un número en modo enlace único.
 *
 * @param {{ tenantId: any, user: { email?: string, name?: string }, phoneNumber: string, displayName?: string, now?: Date }} params
 * @returns {Promise<{ sessionId: string, embedSignupUrl: string|null, onboarding: object|null, inProgress: boolean, created: boolean }>}
 */
async function startLinkOnboarding({ tenantId, user, phoneNumber, displayName, now = new Date() }) {
  if (!(await modoEnlaceHabilitado(tenantId))) throw new AppError('Recurso no disponible', 404);

  const declaredPhone = normalizarTelefonoDeclarado(phoneNumber);
  await asegurarNumeroDisponible({ tenantId, declaredPhone });

  const { session: base, creada } = await obtenerOCrearSesion({ tenantId, declaredPhone, displayName, now });
  const respuesta = async (inProgress) => {
    const actual = await ChannelOnboardingSession.findOne({ _id: base._id, tenantId }).lean();
    return {
      sessionId: String(base._id),
      embedSignupUrl: actual?.gupshup?.embedSignupUrl || null,
      onboarding: actual ? channelOnboardingStatus.clasificar(actual, new Date()) : null,
      inProgress,
      created: creada,
    };
  };

  // Falló en un paso que no es de este flujo (p. ej. creación del canal): lo resuelve el barrido; aquí no se toca nada.
  if (base.status === 'failed' && base.error?.step !== 'gupshup_registration') return respuesta(false);

  const session = await tomarArrendamiento(base._id, now);
  if (!session) return respuesta(true); // otra solicitud está ejecutando los pasos: el cliente sigue con el sondeo

  try {
    const token = await partnerAuth.getValidToken();
    const { enlaceNuevo } = await prepararAppYEnlace({ session, user, token, now });
    logger.info('[channelOnboardingLink] Conexión en modo enlace único lista', {
      tenantId: String(tenantId), sessionId: String(session._id), appId: session.gupshup.appId, creada, enlaceNuevo,
    });
  } catch (err) {
    await marcarFallida(session, err.message);
    logger.warn('[channelOnboardingLink] No se pudo preparar la conexión (reintentable con la misma solicitud)', {
      tenantId: String(tenantId), sessionId: String(session._id), error: err.message,
    });
    throw err;
  } finally {
    await liberarArrendamiento(session._id);
  }
  return respuesta(false);
}

module.exports = {
  modoEnlaceHabilitado,
  normalizarTelefonoDeclarado,
  startLinkOnboarding,
  LEASE_MS,
};
