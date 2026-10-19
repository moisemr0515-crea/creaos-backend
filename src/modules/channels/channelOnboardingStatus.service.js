// channelOnboardingStatus.service.js — estado de la conexión de WhatsApp EN CURSO de un
// tenant, para que el frontend (autoservicio) pueda mostrarlo, retomarlo después de
// recargar/cerrar la pestaña y ofrecer la acción correcta en cada caso.
//
// Incidente de Nutriva (14/oct/2026): el frontend solo sabía si había canal o no; ante
// cualquier demora o falla el cliente quedaba con un spinner y sin acciones. Este
// servicio traduce la ChannelOnboardingSession (+ el calendario del barrido de
// conciliación) a una fase y una acción siguiente, siempre acotado por tenant.
//
// SOLO LECTURA: no llama a Meta ni a Gupshup, no escribe nada.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const { GUPSHUP_PHASE_WINDOW_MS } = ChannelOnboardingSession;

// Solo se consideran sesiones recientes: una de hace semanas no es "la conexión en curso".
const VENTANA_CONSULTA_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESIONES = 10;

const FASES = Object.freeze({
  AWAITING_GUPSHUP: 'awaiting_gupshup', // enlace de Gupshup generado; esperando que el cliente lo complete
  NEEDS_REGISTRATION: 'needs_registration', // Meta autorizado; falta registrar la app/generar el enlace
  ACTIVATING: 'activating', // otro actor (webhook/conciliación) está creando el canal
  REGISTRATION_FAILED: 'registration_failed', // falló el registro en Gupshup (reintentable)
  LINK_EXPIRED: 'link_expired', // la ventana/el enlace venció; recuperable sin repetir Meta
  NEEDS_ATTENTION: 'needs_attention', // la conciliación se detuvo por una condición de seguridad
  META_INCOMPLETE: 'meta_incomplete', // no terminó la autorización de Meta (hay que reiniciar)
});

const ACCIONES = Object.freeze({
  OPEN_LINK: 'open_link',
  VERIFY: 'verify',
  REGISTER: 'register',
  RECOVER: 'recover',
  RESTART: 'restart',
  CONTACT_SUPPORT: 'contact_support',
  WAIT: 'wait',
});

const STATUS_META_INCOMPLETA = ['initiated', 'exchanging_code', 'meta_authorized', 'resolving_number'];

// Modo enlace único: no hay autorización de Meta propia; la base de la conexión es el número declarado.
const esModoEnlace = (s) => s.mode === 'gupshup_link';
const tieneAutorizacionMeta = (s) => (esModoEnlace(s)
  ? Boolean(s.declaredPhone)
  : Boolean(s.meta?.wabaId && s.meta?.phoneNumberId && s.meta?.phoneNumber && s.meta?.accessTokenCipher));

// Condiciones de seguridad en las que el barrido se detuvo -> qué le toca hacer al cliente.
const RAZONES_DETENCION = {
  mismatch: { accion: ACCIONES.RESTART, razon: 'number_mismatch' },
  identity_conflict: { accion: ACCIONES.CONTACT_SUPPORT, razon: 'identity_conflict' },
  app_unsafe: { accion: ACCIONES.RECOVER, razon: 'app_not_safe' },
  stale: { accion: ACCIONES.RECOVER, razon: 'link_expired' },
  excepcion_al_activar: { accion: ACCIONES.VERIFY, razon: 'activation_failed' },
};

function clasificar(s, ahora) {
  const base = {
    sessionId: String(s._id), status: s.status, phoneNumber: s.meta?.phoneNumber || s.declaredPhone || null, expiresAt: s.expiresAt || null,
    mode: esModoEnlace(s) ? 'gupshup_link' : 'meta_then_link',
  };

  if (s.status === 'completed') return null; // conectado: lo informa /whatsapp/status, no hay nada en curso

  if (s.status === 'completing') {
    return { ...base, phase: FASES.ACTIVATING, nextAction: ACCIONES.WAIT, reason: null };
  }

  if (STATUS_META_INCOMPLETA.includes(s.status)) {
    return { ...base, phase: FASES.META_INCOMPLETE, nextAction: ACCIONES.RESTART, reason: null };
  }

  if (s.status === 'expired') {
    return tieneAutorizacionMeta(s)
      ? { ...base, phase: FASES.LINK_EXPIRED, nextAction: ACCIONES.RECOVER, reason: 'link_expired' }
      : { ...base, phase: FASES.META_INCOMPLETE, nextAction: ACCIONES.RESTART, reason: null };
  }

  if (s.status === 'failed') {
    const paso = s.error?.step;
    if (paso === 'gupshup_registration' && tieneAutorizacionMeta(s)) {
      return { ...base, phase: FASES.REGISTRATION_FAILED, nextAction: ACCIONES.REGISTER, reason: 'registration_failed', errorMessage: s.error?.message || null };
    }
    if (paso === 'channel_creation') {
      // El webhook o una conciliación falló al crear el canal; el barrido lo reintenta una vez.
      if (s.reconcile?.stoppedAt) {
        return { ...base, phase: FASES.NEEDS_ATTENTION, nextAction: ACCIONES.VERIFY, reason: 'activation_failed' };
      }
      return { ...base, phase: FASES.ACTIVATING, nextAction: ACCIONES.WAIT, reason: 'retrying_activation' };
    }
    return { ...base, phase: FASES.META_INCOMPLETE, nextAction: ACCIONES.RESTART, reason: null };
  }

  if (s.status === 'gupshup_registering') {
    if (!tieneAutorizacionMeta(s)) {
      return { ...base, phase: FASES.META_INCOMPLETE, nextAction: ACCIONES.RESTART, reason: null };
    }
    const ventanaVencida = s.expiresAt && new Date(s.expiresAt) <= ahora;
    const generadoEn = s.gupshup?.embedSignupUrlGeneratedAt;
    const enlaceVencido = generadoEn && ahora.getTime() - new Date(generadoEn).getTime() > GUPSHUP_PHASE_WINDOW_MS;
    if (ventanaVencida || enlaceVencido) {
      return { ...base, phase: FASES.LINK_EXPIRED, nextAction: ACCIONES.RECOVER, reason: 'link_expired' };
    }
    if (!s.gupshup?.appId || !s.gupshup?.embedSignupUrl) {
      return { ...base, phase: FASES.NEEDS_REGISTRATION, nextAction: ACCIONES.REGISTER, reason: null };
    }
    const detenida = s.reconcile?.stoppedReason && RAZONES_DETENCION[s.reconcile.stoppedReason];
    if (detenida) {
      return { ...base, phase: FASES.NEEDS_ATTENTION, nextAction: detenida.accion, reason: detenida.razon };
    }
    const linkExpiresAt = generadoEn ? new Date(new Date(generadoEn).getTime() + GUPSHUP_PHASE_WINDOW_MS) : s.expiresAt;
    return {
      ...base,
      phase: FASES.AWAITING_GUPSHUP,
      nextAction: ACCIONES.OPEN_LINK,
      reason: s.reconcile?.lastOutcome === 'error' ? 'temporary_error' : null,
      embedSignupUrl: s.gupshup.embedSignupUrl,
      linkExpiresAt,
      lastCheckAt: s.reconcile?.lastAttemptAt || null,
    };
  }

  return null;
}

// Fases accionables primero: una sesión abandonada en el popup de Meta (más nueva) no debe
// esconder una conexión que sí está esperando a Gupshup.
const ES_ACCIONABLE = (resultado) => resultado && resultado.phase !== FASES.META_INCOMPLETE;

/**
 * @param {{ tenantId: import('mongoose').Types.ObjectId|string, now?: Date }} params
 * @returns {Promise<object|null>} la conexión en curso, o null si no hay nada pendiente
 *   (sin sesiones recientes, ya conectado, o solo intentos abandonados en el popup de Meta).
 */
async function getCurrentOnboarding({ tenantId, now = new Date() }) {
  const sesiones = await ChannelOnboardingSession.find({
    tenantId,
    createdAt: { $gte: new Date(now.getTime() - VENTANA_CONSULTA_MS) },
  }).sort({ createdAt: -1 }).limit(MAX_SESIONES).lean();

  for (const sesion of sesiones) {
    if (sesion.status === 'completed') return null; // la más reciente ya terminó: nada en curso
    const resultado = clasificar(sesion, now);
    if (ES_ACCIONABLE(resultado)) return resultado;
  }
  return null;
}

module.exports = { getCurrentOnboarding, clasificar, FASES, ACCIONES };
