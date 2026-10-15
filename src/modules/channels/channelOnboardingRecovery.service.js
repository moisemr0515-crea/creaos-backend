// channelOnboardingRecovery.service.js — recupera una sesión de onboarding que
// ya pasó la autorización de Meta pero quedó trabada en la fase de Gupshup, SIN
// repetir el popup de Meta ni crear otra WABA.
//
// Incidente de Nutriva (14/oct/2026). Dos defectos dejaban la sesión varada:
//  1. `expiresAt` (ventana de 30 min del popup de Meta) nunca se renovaba: la
//     expiración perezosa de channel.controller.js la marcaba `expired`
//     (irrecuperable por /complete-gupshup) en la siguiente lectura.
//  2. Estaba atada a una app de Gupshup ya Live con el número anterior.
//
// Esta función corrige el estado de UNA sesión, acotada por tenant, y es
// idempotente: repetirla no cambia nada más. NO llama a Meta ni a Gupshup, NO crea
// apps ni canales, NO toca credenciales ni webhooks, y conserva el sessionId, los
// IDs de Meta (wabaId, phoneNumberId, metaBusinessId si existe) y el token de Meta
// cifrado. La app nueva y el link de Gupshup los resuelve después
// /complete-gupshup (channelOnboardingApp.service.js), que ya sabe elegir una app
// segura.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const { evaluarAppLocal } = require('./channelOnboardingApp.service');
const { AppError } = require('../../middleware/error.middleware');
const logger = require('../../utils/logger');

const { GUPSHUP_PHASE_WINDOW_MS, RECONCILE_INITIAL_STATE } = ChannelOnboardingSession;

// Pasos cuyo fallo SÍ se puede reintentar sin rehacer el popup de Meta.
const PASOS_FALLIDOS_RECUPERABLES = ['gupshup_registration', 'channel_creation'];

const FILTRO_ESTADO_RECUPERABLE = [
  { status: 'gupshup_registering' },
  { status: 'expired' },
  { status: 'failed', 'error.step': { $in: PASOS_FALLIDOS_RECUPERABLES } },
];

/**
 * @param {{ sessionId: string, tenantId: import('mongoose').Types.ObjectId|string }} params
 * @returns {Promise<{ outcome: 'recovered'|'already_ready'|'already_completed', sessionId: string,
 *   status?: string, expiresAt?: Date, appDetached?: boolean, previousStatus?: string, channelId?: any }>}
 * @throws {AppError} 404 si no existe / es de otro tenant; 409 si no es recuperable.
 */
async function recoverPendingSession({ sessionId, tenantId }) {
  const session = await ChannelOnboardingSession.findOne({ _id: sessionId, tenantId });
  if (!session) throw new AppError('Sesión de onboarding no encontrada', 404);

  if (session.status === 'completed' || session.channel) {
    return { outcome: 'already_completed', sessionId: String(session._id), channelId: session.channel || null };
  }

  const meta = session.meta || {};
  if (!meta.wabaId || !meta.phoneNumberId || !meta.phoneNumber || !meta.accessTokenCipher) {
    throw new AppError('La sesión no conserva una autorización Meta completa — no es recuperable, hay que reiniciar el onboarding desde /init', 409);
  }

  const estadoRecuperable = session.status === 'gupshup_registering'
    || session.status === 'expired'
    || (session.status === 'failed' && PASOS_FALLIDOS_RECUPERABLES.includes(session.error?.step));
  if (!estadoRecuperable) {
    throw new AppError(`La sesión está en estado "${session.status}" y no es recuperable`, 409);
  }

  const previousStatus = session.status;

  // 1) Reabrir: estado 'gupshup_registering' + ventana de la fase Gupshup. Reclamo
  // atómico y acotado por tenant; nunca pisa una sesión que ya tiene canal.
  const reabierta = await ChannelOnboardingSession.findOneAndUpdate(
    { _id: session._id, tenantId, channel: { $exists: false }, $or: FILTRO_ESTADO_RECUPERABLE },
    {
      $set: {
        status: 'gupshup_registering',
        expiresAt: new Date(Date.now() + GUPSHUP_PHASE_WINDOW_MS),
        'error.step': null,
        'error.message': null,
        // Sesión recuperada: el barrido automático la vuelve a considerar con el
        // calendario de reintentos de cero.
        reconcile: { ...RECONCILE_INITIAL_STATE },
      },
    },
    { new: true }
  );
  if (!reabierta) throw new AppError('La sesión cambió de estado mientras se recuperaba — reintentá', 409);

  // 2) Si la app asociada no es segura para este número, desvincularla DE LA
  // SESIÓN (la app en Gupshup queda intacta). Condicionado al appId leído, así dos
  // recuperaciones simultáneas no pisan una selección posterior.
  let appDetached = false;
  const appId = reabierta.gupshup?.appId;
  if (appId) {
    const evaluacion = await evaluarAppLocal({ appId, session: reabierta, tenantId });
    if (!evaluacion.seguro) {
      const res = await ChannelOnboardingSession.updateOne(
        { _id: reabierta._id, tenantId, 'gupshup.appId': appId },
        {
          $set: {
            'gupshup.appId': null,
            'gupshup.appName': null,
            'gupshup.webhookReference': null,
            'gupshup.messagesWebhookReference': null,
            'gupshup.embedSignupUrl': null,
            'gupshup.embedSignupUrlGeneratedAt': null,
          },
        }
      );
      appDetached = res.modifiedCount > 0;
      logger.warn('[channelOnboardingRecovery] App no segura desvinculada de la sesión (la app en Gupshup no se tocó)', {
        tenantId: String(tenantId), sessionId: String(reabierta._id), appId, motivo: evaluacion.motivo,
      });
    }
  }

  const huboCambios = previousStatus !== 'gupshup_registering' || appDetached;
  logger.info('[channelOnboardingRecovery] Sesión de onboarding revisada', {
    tenantId: String(tenantId), sessionId: String(reabierta._id), previousStatus, appDetached, huboCambios,
  });

  return {
    outcome: huboCambios ? 'recovered' : 'already_ready',
    sessionId: String(reabierta._id),
    status: 'gupshup_registering',
    expiresAt: reabierta.expiresAt,
    appDetached,
    previousStatus,
  };
}

module.exports = { recoverPendingSession };
