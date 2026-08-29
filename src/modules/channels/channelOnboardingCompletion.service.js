// channelOnboardingCompletion.service.js — PR-06 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md). Reacciona al
// webhook de Gupshup que confirma que el customer terminó el Embed Signup
// del lado de Gupshup: evento `account-event` con `status: ACCOUNT_VERIFIED`
// (Go-Live), entregado vía la Subscription API en modo ACCOUNT — suscripta
// para esta app en channel.controller.js#completeGupshupEmbeddedSignup()
// (PR-05, extendido en PR-06). Ver docs/integrations/gupshup-registration-
// contract.md §11 para el contrato completo, con fuentes.
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
const { nombreAppGupshup } = require('./channel.controller');
const logger = require('../../utils/logger');

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
 * Crea el WhatsAppChannel (connectionType: DEDICATED) + ChannelCredentials
 * reales para el tenant dueño de `gsAppId`, y transiciona su
 * ChannelOnboardingSession de 'gupshup_registering' a 'completed'.
 *
 * Nunca tira — cada caso sin acción posible (sesión inexistente, sesión en
 * un estado que no sea 'gupshup_registering', datos inconsistentes) es un
 * no-op logueado, nunca una excepción sin capturar:
 *
 *   - `gsAppId` sin ninguna sesión asociada: puede ser el canal PLATFORM,
 *     una app de prueba, o simplemente ruido — no es un error nuestro,
 *     Gupshup puede mandar este evento para cualquier app de la cuenta.
 *   - Sesión encontrada pero NO en 'gupshup_registering': típicamente una
 *     reentrega del mismo webhook (Gupshup documenta entrega at-least-once,
 *     no exactly-once) sobre una sesión que ya quedó 'completed' — no
 *     repetir la creación del canal. También cubre 'failed'/'expired'.
 *
 * LIMITACIÓN CONOCIDA (identificada en el diseño de PR-06, no resuelta acá
 * a propósito): si falla a mitad de camino (ej. WhatsAppChannel se crea
 * pero ChannelCredentials falla), la sesión queda 'failed' y NINGÚN mecanismo
 * la reintenta automáticamente — a diferencia de /complete-gupshup (PR-05),
 * este paso no tiene un endpoint HTTP que el usuario pueda volver a llamar.
 * Solo una redelivery real del mismo webhook por parte de Gupshup podría
 * reintentarlo, y no está garantizada. Aceptable para PR-06 (no se pidió
 * diseñar una vía de retry acá), pero documentado para no perderlo de vista.
 *
 * @param {string} gsAppId
 */
async function handleGupshupAccountVerified(gsAppId) {
  const session = await ChannelOnboardingSession.findOne({ 'gupshup.appId': gsAppId });

  if (!session) {
    logger.warn('[channelOnboardingCompletion] account-event sin ninguna ChannelOnboardingSession asociada', { gsAppId });
    return;
  }

  if (session.status !== 'gupshup_registering') {
    logger.info('[channelOnboardingCompletion] account-event para una sesión que ya no está en gupshup_registering, no-op', {
      sessionId: String(session._id),
      currentStatus: session.status,
    });
    return;
  }

  if (!session.meta?.phoneNumber || !session.meta?.phoneNumberId) {
    // No debería pasar nunca en este estado — callbackEmbeddedSignup() (PR-04)
    // ya los deja seteados antes de avanzar a gupshup_registering. Fail-loud:
    // es un estado inconsistente real, no algo que un retry vaya a arreglar solo.
    await markFailed(session, `Sesión ${session._id} en gupshup_registering sin phoneNumber/phoneNumberId — estado inconsistente`);
    return;
  }

  try {
    const token = await partnerAuth.getValidToken();
    const { apikey } = await partnerApps.getAppAccessToken(session.gupshup.appId, token);

    const channel = await WhatsAppChannel.create({
      tenantId: session.tenantId,
      businessId: session.tenantId,
      connectionType: 'DEDICATED',
      status: 'active',
      onboardingStatus: 'completed',
      phoneNumber: session.meta.phoneNumber,
      phoneNumberId: session.meta.phoneNumberId,
      wabaId: session.meta.wabaId,
      providerAppId: session.gupshup.appId,
      // PR-07a: el NOMBRE de la app en Gupshup (no su GUID) — mismo campo
      // que el seed de PLATFORM puebla con GUPSHUP_APP_NAME (ver
      // scripts/seed-whatsapp-channel-platform.js). Sin esto, el envío
      // saliente por este canal (gupshupProvider.js/gupshup.client.js) no
      // tiene forma de armar `src.name`. Determinístico: es el mismo nombre
      // con el que se creó la app en Gupshup (partnerApps.createApp(),
      // PR-05) — nombreAppGupshup() reutilizada tal cual, no se duplica la
      // convención de naming en dos lugares. Confirmado en producción antes
      // de este PR: 0 canales DEDICATED existentes, no hace falta backfill.
      providerAccountId: nombreAppGupshup(session.tenantId),
      webhookReference: session.gupshup.webhookReference,
      displayName: session.displayName,
    });

    const credentials = await ChannelCredentials.create({
      channel: channel._id,
      tenantId: session.tenantId,
      provider: 'gupshup',
      apiKeys: [{ value: channelCrypto.encrypt(apikey, String(channel._id)) }],
    });

    channel.credentialsReference = credentials._id;
    await channel.save();

    session.channel = channel._id;
    session.status = 'completed';
    session.error = { step: null, message: null };
    // El token de Meta ya no tiene ningún uso a partir de acá — ni Gupshup
    // ni ningún paso posterior lo necesitan (confirmado, ver
    // docs/integrations/gupshup-registration-contract.md §2/§9.4). Se limpia
    // por higiene: no hay razón para retener un secreto cifrado más tiempo
    // del necesario.
    session.meta.accessTokenCipher = null;
    await session.save();

    logger.info('[channelOnboardingCompletion] WhatsAppChannel DEDICATED creado, onboarding completado', {
      tenantId: String(session.tenantId),
      sessionId: String(session._id),
      channelId: String(channel._id),
    });
  } catch (err) {
    await markFailed(session, err.message);
  }
}

module.exports = { handleGupshupAccountVerified, isAccountVerifiedEvent };
