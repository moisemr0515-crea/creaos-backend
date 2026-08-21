const PushToken = require('./push.model');
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
  return PushToken.findOneAndUpdate(
    { user: userId, token },
    {
      $set: {
        business: businessId,
        platform: platform || 'android',
        deviceId: deviceId || null,
        isActive: true,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
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
const sendToUser = async (userId, { title, body, data = {} }) => {
  if (!isConfigured()) {
    logger.warn('[push] Firebase no configurado (faltan FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY) — envío omitido', { userId });
    return { sent: 0, failed: 0, tokens: 0 };
  }

  const pushTokens = await PushToken.find({ user: userId, isActive: true });
  if (pushTokens.length === 0) {
    return { sent: 0, failed: 0, tokens: 0 };
  }

  const messaging = getMessaging();
  const response = await messaging.sendEachForMulticast({
    tokens: pushTokens.map((pt) => pt.token),
    notification: { title, body },
    // El payload "data" de FCM solo admite valores string — se serializan
    // acá para no imponerle esa restricción al llamador (mismo criterio
    // que Notification.meta, que sí acepta cualquier tipo).
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      ])
    ),
  });

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

  return {
    sent: response.successCount,
    failed: response.failureCount,
    tokens: pushTokens.length,
  };
};

module.exports = { registrarToken, desregistrarToken, sendToUser };
