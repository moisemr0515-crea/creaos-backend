const PushToken = require('./push.model');
const crypto = require('crypto');
const { getMessaging, isConfigured } = require('../../utils/firebase');
const logger = require('../../utils/logger');

// Códigos de error que FCM devuelve cuando un token está definitivamente
// muerto (app desinstalada, token rotado sin re-registrar) — distinto de
// un fallo transitorio de red o de cuota, que sí puede tener sentido
// reintentar más adelante y NO debe apagar el token.
const TOKEN_DEAD_ERROR_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
];

// La app 1.6.1 usa el canal fallback oficial de Firebase/Android. No se
// inventa un channelId nativo nuevo en este fix backend-only; FCM crea/usa
// este canal cuando la app no declara otro canal por defecto.
const DEFAULT_ANDROID_CHANNEL_ID = 'fcm_fallback_notification_channel';

const tokenFingerprint = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);

/**
 * Registra o actualiza un token FCM para el usuario autenticado — upsert
 * por {user, token} (índice único del modelo), así que llamar esto de
 * nuevo con el mismo token es idempotente: no crea una fila duplicada,
 * solo refresca lastSeenAt/deviceId/platform.
 *
 * Reactiva el token si venía con isActive:false — caso real: FCM lo había
 * marcado inválido (ver push.service.js#sendToUser(), PR-B) y el mismo
 * dispositivo se re-registra después (ej. tras un reinstall que termina
 * generando el mismo token, o una reconexión).
 *
 * Sin lógica de ENVÍO acá — eso es sendToUser() en PR-B. Este archivo
 * solo administra el registro de tokens.
 */
const registrarToken = async (userId, businessId, { token, platform, deviceId }) => {
  const normalizedDeviceId = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null;
  const update = {
    business: businessId,
    token,
    platform: platform || 'android',
    deviceId: normalizedDeviceId,
    isActive: true,
    lastSeenAt: new Date(),
  };

  // Compatibilidad con registros existentes previos a deviceId: el token
  // conocido se adopta primero. Si FCM rotó el token, el deviceId estable
  // encuentra y actualiza la misma fila, evitando dos pushes al dispositivo.
  const existingByToken = await PushToken.findOne({ user: userId, token });
  if (existingByToken) {
    Object.assign(existingByToken, update);
    return existingByToken.save();
  }

  const filter = normalizedDeviceId
    ? { user: userId, deviceId: normalizedDeviceId }
    : { user: userId, token };
  return PushToken.findOneAndUpdate(filter, { $set: update }, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
};

/**
 * Desregistra un token — soft (isActive:false), no hard-delete, mismo
 * criterio que el resto del repo (nunca hard-delete directo desde acá).
 * No lanza si el token no existía o ya pertenecía a otro usuario — el
 * resultado (null) es indistinguible de "nada que desregistrar", que es
 * el comportamiento correcto para un logout: no hay nada de qué avisar
 * al usuario si el token ya no estaba.
 */
const desregistrarToken = async (userId, token) => {
  return PushToken.findOneAndUpdate(
    { user: userId, token },
    { $set: { isActive: false } },
    { new: true }
  );
};

/**
 * Envía una notificación push a todos los dispositivos activos de un
 * usuario vía FCM (admin.messaging().sendEachForMulticast()).
 *
 * Fail-soft en dos niveles, a propósito:
 * - Si Firebase no está configurado (Railway sin las 3 variables
 *   FIREBASE_*, ej. este PR recién mergeado y las credenciales todavía
 *   pendientes) o el usuario no tiene ningún PushToken activo (todavía no
 *   instaló la app / no dio permiso — estado normal, no un error), vuelve
 *   {sent:0, failed:0, tokens:0} sin lanzar. El llamador (automation.engine
 *   u otro disparador) no debe romperse porque el usuario no tenga push
 *   habilitado.
 * - Si sendEachForMulticast() SÍ corre, un fallo de red/cuota/credenciales
 *   inválidas se deja propagar (igual que gupshupProvider.js — el llamador
 *   decide si envolver en try/catch, no se traga acá).
 *
 * Tokens muertos (ver TOKEN_DEAD_ERROR_CODES): se desactivan (isActive:
 * false) en cuanto FCM los reporta como inválidos — no se reintenta
 * indefinidamente. Se reactivan solos si el mismo dispositivo vuelve a
 * llamar POST /push/register (ver registrarToken() arriba).
 */
const sendToUser = async (userId, {
  title,
  body,
  data = {},
  tenantId = null,
  correlationId = null,
  eventType = 'generic',
  channelId = DEFAULT_ANDROID_CHANNEL_ID,
}) => {
  if (!isConfigured()) {
    logger.warn('[push] Firebase no configurado (faltan FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY) — envío omitido', { userId });
    return { sent: 0, failed: 0, tokens: 0 };
  }

  const tokenFilter = { user: userId, isActive: true };
  if (tenantId) tokenFilter.business = tenantId;
  const pushTokens = await PushToken.find(tokenFilter);
  if (pushTokens.length === 0) {
    logger.info('[push] sin dispositivos activos para destinatario', {
      correlationId,
      tenantId: tenantId ? String(tenantId) : null,
      userId: String(userId),
      eventType,
    });
    return { sent: 0, failed: 0, tokens: 0 };
  }

  const messaging = getMessaging();
  const serializedData = Object.fromEntries(
    Object.entries({ ...data, ...(correlationId ? { correlationId } : {}) }).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  );
  const payload = {
    tokens: pushTokens.map((pt) => pt.token),
    notification: { title, body },
    data: serializedData,
    android: {
      priority: 'high',
      notification: { channelId },
    },
  };

  logger.info('[push] envío FCM iniciado', {
    correlationId,
    tenantId: tenantId ? String(tenantId) : null,
    userId: String(userId),
    eventType,
    devices: pushTokens.length,
    tokenFingerprints: pushTokens.map((pt) => tokenFingerprint(pt.token)),
    payloadType: 'notification+data',
    channelId,
    priority: 'high',
  });

  const response = await messaging.sendEachForMulticast(payload);

  const tokensAMarcarInactivos = response.responses
    .map((result, i) => ({ result, pushToken: pushTokens[i] }))
    .filter(({ result }) => !result.success && TOKEN_DEAD_ERROR_CODES.includes(result.error?.code))
    .map(({ pushToken }) => pushToken._id);

  if (tokensAMarcarInactivos.length > 0) {
    await PushToken.updateMany(
      { _id: { $in: tokensAMarcarInactivos } },
      { $set: { isActive: false } }
    );
  }

  const messageIds = response.responses
    .filter((result) => result.success && result.messageId)
    .map((result) => result.messageId);
  const errorCodes = response.responses
    .filter((result) => !result.success)
    .map((result) => result.error?.code || 'unknown');

  logger.info('[push] envío FCM completado', {
    correlationId,
    tenantId: tenantId ? String(tenantId) : null,
    userId: String(userId),
    eventType,
    sent: response.successCount,
    failed: response.failureCount,
    messageIds,
    errorCodes,
    invalidTokensDeactivated: tokensAMarcarInactivos.length,
  });

  return {
    sent: response.successCount,
    failed: response.failureCount,
    tokens: pushTokens.length,
    messageIds,
    errorCodes,
    channelId,
  };
};

module.exports = { registrarToken, desregistrarToken, sendToUser, DEFAULT_ANDROID_CHANNEL_ID };
