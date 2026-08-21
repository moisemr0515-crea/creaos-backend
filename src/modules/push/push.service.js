const PushToken = require('./push.model');

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

module.exports = { registrarToken, desregistrarToken };
