// channel.controller.js — handlers HTTP del módulo channels/ (primera vez
// que expone rutas propias). PR-03 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §19-20): SOLO el
// endpoint de init del Embedded Signup. El callback de Meta (§21, PR-04) y
// cualquier llamada real a Gupshup Partner API (createApp() y el resto,
// PR-05+) todavía no existen — esta sesión se completa recién en esos PRs.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito } = require('../../utils/response');
const logger = require('../../utils/logger');
const { META_APP_ID, META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID } = require('../../config/env');

const DISPLAY_NAME_MAX_LENGTH = 100;

// Estados de ChannelOnboardingSession que cuentan como "sin terminar" (ver
// STATUSES en channelOnboardingSession.model.js) — completed/failed/expired
// no compiten por nada, no hace falta ni contarlos.
const ESTADOS_SIN_TERMINAR = ['initiated', 'meta_authorized', 'gupshup_registering'];

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

module.exports = { initEmbeddedSignup };
