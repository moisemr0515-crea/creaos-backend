// channelOnboardingReconcileSweep.service.js — barrido automático de conciliación
// del onboarding de WhatsApp. Incidente de Nutriva (14/oct/2026): el canal solo se
// creaba si Gupshup enviaba el webhook ACCOUNT_VERIFIED; sin él, la sesión quedaba
// pendiente para siempre aunque la app estuviera Live (y aunque el usuario cerrara
// CREA OS). Este barrido corre en el worker existente (BullMQ repeatable job, ver
// onboardingReconcileSweep.queue.js/.worker.js) y es el RESPALDO del webhook:
//
//  - Prioridad del webhook: no consulta una sesión hasta FIRST_POLL_DELAY_MS después
//    de generarle el link, solo toma sesiones todavía en 'gupshup_registering' (si el
//    webhook ya la completó, ni se ve) y comparte el reclamo atómico de
//    reconcileOnboardingSession() con el webhook — nunca pueden crear dos canales.
//  - NO activa nada por sí mismo: delega en reconcileOnboardingSession(), que exige
//    app Live (accountStatus ACTIVE), datos suficientes, número exacto y tenant/WABA
//    sin conflicto. Un estado distinto de ACTIVE o información insuficiente deja la
//    sesión pendiente y registra el diagnóstico.
//  - NUNCA crea apps, WABAs, suscripciones, links ni sesiones: solo lee estado de
//    Gupshup (apikey de la app + GET waba/info) y, si todo coincide, completa la
//    sesión que ya existía.
//  - Límites: cuota GLOBAL compartida con la API en Redis (partnerRateLimit.js: el
//    barrido corre con prioridad 'background', máx. 5 de las 10 req/60s, sin
//    reintentos del cliente y fail-closed si Redis no responde), tope de sesiones
//    por despertar, backoff por sesión, plazo máximo (la vigencia del link de
//    Gupshup, 5 días), pausa de 10 min ante un 429 real de Gupshup, y arrendamiento
//    por sesión para que dos instancias del worker nunca consulten la misma a la vez.
//  - Solo toma sesiones con `expiresAt` vigente: una sesión vencida (ej. la de Nutriva
//    antes de su recuperación autorizada) no se procesa ni se modifica; la reabre
//    únicamente channelOnboardingRecovery.service.js, que renueva `expiresAt`.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const { reconcileOnboardingSession } = require('./channelOnboardingCompletion.service');
const { runWithPartnerPriority, PRIORITY } = require('./providers/gupshup/partnerRateLimit');
const { ONBOARDING_RECONCILE_BATCH_SIZE } = require('../../config/env');
const logger = require('../../utils/logger');

const { GUPSHUP_PHASE_WINDOW_MS } = ChannelOnboardingSession;

// Margen para que el webhook (camino principal) llegue primero tras generar el link.
const FIRST_POLL_DELAY_MS = 2 * 60 * 1000;
// Espera tras el intento N (el último valor se repite hasta el plazo máximo).
const BACKOFF_SCHEDULE_MS = [2, 5, 10, 20, 30].map((minutos) => minutos * 60 * 1000);
// Arrendamiento: al tomar una sesión se adelanta su próximo intento; si el proceso
// muere a mitad, vuelve a estar disponible pasado este tiempo.
const LEASE_MS = 3 * 60 * 1000;
const IN_PROGRESS_RETRY_MS = 60 * 1000;
const RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;
// Cupo local agotado (no hubo solicitud a Gupshup): se reintenta cuando el cupo se
// libera, acotado; sin Redis no se puede medir el cupo, así que se espera más.
const LOCAL_LIMIT_MIN_RETRY_MS = 5 * 1000;
const LOCAL_LIMIT_MAX_RETRY_MS = 60 * 1000;
const LIMITER_UNAVAILABLE_RETRY_MS = 2 * 60 * 1000;
const CODE_LOCAL_LIMIT = 'PARTNER_LOCAL_RATE_LIMIT';
const CODE_LIMITER_UNAVAILABLE = 'PARTNER_LIMITER_UNAVAILABLE';
const DIAGNOSTIC_MAX_LENGTH = 300;

// Resultados tras los cuales NO tiene sentido seguir consultando: o terminó, o
// necesita que una persona la revise (reintentar solo gastaría cuota del Partner API).
const OUTCOMES_TERMINALES = new Set([
  'completed', 'already_completed', 'mismatch', 'identity_conflict', 'app_unsafe',
  'stale', 'invalid_state', 'not_found', 'not_ready',
]);
// De estos, los que son problemas (no éxitos) se registran como warn.
const OUTCOMES_QUE_REQUIEREN_REVISION = new Set(['mismatch', 'identity_conflict', 'app_unsafe']);

const esLimiteLocal = (resultado) => resultado.outcome === 'error' && resultado.code === CODE_LOCAL_LIMIT;
const esLimitadorNoDisponible = (resultado) => resultado.outcome === 'error' && resultado.code === CODE_LIMITER_UNAVAILABLE;

function esperaTrasIntento(intentos) {
  const indice = Math.min(Math.max(intentos, 1), BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[indice];
}

// Sesiones que ya terminaron la autorización de Meta (WABA, phoneNumberId y número
// guardados), tienen una app asignada y un link de Gupshup vigente generado hace al
// menos FIRST_POLL_DELAY_MS, y cuyo próximo intento ya venció (o nunca se hizo).
// Estados: 'gupshup_registering' (esperando a Gupshup) y 'failed'/'channel_creation'
// (el webhook u otra conciliación falló al crear el canal: se reintenta UNA vez más —
// si el reintento también falla, el barrido registra stoppedAt y no insiste).
// Nunca 'completing' (la tiene otro actor) ni 'completed'.
function filtroVencidas(ahora) {
  return {
    $and: [
      { $or: [{ status: 'gupshup_registering' }, { status: 'failed', 'error.step': 'channel_creation' }] },
      { $or: [{ 'reconcile.nextAttemptAt': null }, { 'reconcile.nextAttemptAt': { $lte: ahora } }] },
    ],
    // Sesión vencida = no se toca (se reabre solo con la recuperación autorizada).
    expiresAt: { $gt: ahora },
    'gupshup.appId': { $ne: null },
    'gupshup.embedSignupUrlGeneratedAt': {
      $gte: new Date(ahora.getTime() - GUPSHUP_PHASE_WINDOW_MS),
      $lte: new Date(ahora.getTime() - FIRST_POLL_DELAY_MS),
    },
    // Flujo clásico: autorización de Meta completa. Modo enlace único: el número declarado (no hay datos de Meta).
    $or: [
      { 'meta.wabaId': { $ne: null }, 'meta.phoneNumberId': { $ne: null }, 'meta.phoneNumber': { $ne: null } },
      { mode: 'gupshup_link', declaredPhone: { $ne: null } },
    ],
    'reconcile.stoppedAt': null,
  };
}

// Diagnóstico corto y sin secretos: solo outcome + motivos/estados que ya devolvió
// la conciliación y un mensaje de error truncado (los mensajes de Gupshup no
// contienen credenciales).
function armarDiagnostico(resultado) {
  const partes = [`outcome=${resultado.outcome}`];
  for (const clave of ['reason', 'accountStatus', 'dockerStatus', 'statusCode', 'expected', 'found']) {
    if (resultado[clave] !== undefined && resultado[clave] !== null) partes.push(`${clave}=${resultado[clave]}`);
  }
  if (resultado.message) partes.push(`message=${String(resultado.message).slice(0, 160)}`);
  return partes.join(' ').slice(0, DIAGNOSTIC_MAX_LENGTH);
}

async function registrarResultado(sesion, resultado, ahora) {
  const set = {
    'reconcile.lastOutcome': resultado.outcome,
    'reconcile.lastDiagnostic': armarDiagnostico(resultado),
  };

  if (resultado.thrown || OUTCOMES_TERMINALES.has(resultado.outcome)) {
    set['reconcile.stoppedAt'] = ahora;
    set['reconcile.stoppedReason'] = resultado.thrown ? 'excepcion_al_activar' : resultado.outcome;
    set['reconcile.nextAttemptAt'] = null;
  } else {
    let espera;
    if (resultado.outcome === 'in_progress') espera = IN_PROGRESS_RETRY_MS;
    else if (esLimiteLocal(resultado)) {
      espera = Math.min(Math.max((resultado.retryAfterMs || 0) + 1000, LOCAL_LIMIT_MIN_RETRY_MS), LOCAL_LIMIT_MAX_RETRY_MS);
    } else if (esLimitadorNoDisponible(resultado)) espera = LIMITER_UNAVAILABLE_RETRY_MS;
    else if (resultado.outcome === 'error' && resultado.statusCode === 429) espera = RATE_LIMIT_PAUSE_MS;
    else espera = esperaTrasIntento(sesion.reconcile?.attempts || 1);
    set['reconcile.nextAttemptAt'] = new Date(ahora.getTime() + espera);
  }

  const update = { $set: set };
  // Si no salió ninguna solicitud a Gupshup (cupo local / Redis caído) el intento no
  // cuenta para el backoff de la sesión.
  if (esLimiteLocal(resultado) || esLimitadorNoDisponible(resultado)) update.$inc = { 'reconcile.attempts': -1 };
  await ChannelOnboardingSession.updateOne({ _id: sesion._id }, update);
}

/**
 * Un despertar del barrido. Idempotente y seguro de ejecutar en paralelo.
 *
 * @param {{ now?: Date, batchSize?: number }} [opts]
 * @returns {Promise<{ revisadas: number, completadas: number, pendientes: number,
 *   detenidas: number, errores: number, pausadoPorLimiteDeFrecuencia: boolean }>}
 */
async function sweepPendingOnboardingSessions({ now = new Date(), batchSize = ONBOARDING_RECONCILE_BATCH_SIZE } = {}) {
  const resumen = { revisadas: 0, completadas: 0, pendientes: 0, detenidas: 0, errores: 0, pausadoPorLimiteDeFrecuencia: false };

  // Se miran más candidatas que el tope porque algunas pueden ser tomadas por otra
  // instancia entre esta lectura y el arrendamiento de abajo.
  const candidatas = await ChannelOnboardingSession.find(filtroVencidas(now))
    .sort({ 'reconcile.nextAttemptAt': 1, createdAt: 1 })
    .limit(batchSize * 3)
    .select('_id')
    .lean();

  for (const candidata of candidatas) {
    if (resumen.revisadas >= batchSize) break;

    // Arrendamiento atómico: solo UNA instancia gana cada sesión por intento. El
    // filtro vuelve a exigir que siga pendiente y vencida en el momento exacto.
    const sesion = await ChannelOnboardingSession.findOneAndUpdate(
      { _id: candidata._id, ...filtroVencidas(now) },
      {
        $set: { 'reconcile.lastAttemptAt': now, 'reconcile.nextAttemptAt': new Date(now.getTime() + LEASE_MS) },
        $inc: { 'reconcile.attempts': 1 },
      },
      { new: true }
    ).select('_id tenantId reconcile').lean();
    if (!sesion) continue; // la tomó otra instancia, o cambió de estado

    resumen.revisadas += 1;

    let resultado;
    try {
      // Prioridad 'background': cuota global reducida y sin reintentos del cliente HTTP.
      resultado = await runWithPartnerPriority(
        PRIORITY.BACKGROUND,
        () => reconcileOnboardingSession({ sessionId: sesion._id, tenantId: sesion.tenantId })
      );
    } catch (err) {
      // reconcile solo lanza si falló al ACTIVAR (la sesión queda failed/channel_creation).
      resultado = { outcome: 'error', message: err.message, statusCode: err.statusCode || null, thrown: true };
    }

    await registrarResultado(sesion, resultado, now);

    const contexto = {
      tenantId: String(sesion.tenantId), sessionId: String(sesion._id), intento: sesion.reconcile?.attempts,
      outcome: resultado.outcome, diagnostico: armarDiagnostico(resultado),
    };
    if (resultado.outcome === 'completed') {
      resumen.completadas += 1;
      logger.info('[onboardingReconcileSweep] Canal conectado por conciliación (el webhook no había llegado)', contexto);
    } else if (resultado.thrown || OUTCOMES_QUE_REQUIEREN_REVISION.has(resultado.outcome)) {
      resumen.detenidas += 1;
      logger.warn('[onboardingReconcileSweep] Sesión detenida: requiere revisión humana', contexto);
    } else if (OUTCOMES_TERMINALES.has(resultado.outcome)) {
      resumen.detenidas += 1;
      logger.info('[onboardingReconcileSweep] Sesión sin nada más que conciliar', contexto);
    } else if (resultado.outcome === 'error') {
      resumen.errores += 1;
      logger.warn('[onboardingReconcileSweep] No se pudo consultar a Gupshup; se reintenta con backoff', contexto);
    } else {
      resumen.pendientes += 1;
      logger.info('[onboardingReconcileSweep] Sigue pendiente en Gupshup; se reintenta con backoff', contexto);
    }

    // 429 (de Gupshup o del cupo local) o limitador caído: se corta el despertar
    // completo, no se insiste con el resto.
    if (resultado.outcome === 'error' && (resultado.statusCode === 429 || esLimitadorNoDisponible(resultado))) {
      resumen.pausadoPorLimiteDeFrecuencia = true;
      logger.warn('[onboardingReconcileSweep] Límite de frecuencia de Gupshup — se pausa el barrido', contexto);
      break;
    }
  }

  if (resumen.revisadas > 0) logger.info('[onboardingReconcileSweep] Barrido completo', resumen);
  return resumen;
}

module.exports = {
  sweepPendingOnboardingSessions,
  FIRST_POLL_DELAY_MS,
  BACKOFF_SCHEDULE_MS,
  LEASE_MS,
  RATE_LIMIT_PAUSE_MS,
  IN_PROGRESS_RETRY_MS,
  LOCAL_LIMIT_MIN_RETRY_MS,
  LOCAL_LIMIT_MAX_RETRY_MS,
  LIMITER_UNAVAILABLE_RETRY_MS,
};
