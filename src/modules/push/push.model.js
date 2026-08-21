const mongoose = require('mongoose');

// Solo 'android' hace falta hoy (PR-A del plan de empaquetado Android/
// Capacitor) — 'ios' queda contemplado en el enum para no tener que tocar
// el schema el día que exista una versión iOS, aunque nada lo use todavía.
const PLATFORMS = ['android', 'ios'];

const pushTokenSchema = new mongoose.Schema(
  {
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Denormalizado — mismo criterio que Conversation.business,
    // Notification.business, etc.: evita un populate extra para filtrar
    // envíos por tenant si hace falta más adelante.
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    token:    { type: String, required: true },
    platform: { type: String, enum: PLATFORMS, default: 'android' },
    // Permite distinguir varios dispositivos del mismo usuario — un
    // usuario puede tener la app instalada en más de un teléfono.
    deviceId: { type: String, default: null },
    // Soft-deactivate, nunca hard-delete — mismo criterio que el resto
    // del repo. Se apaga sola cuando FCM devuelve el token como inválido
    // al mandar (eso lo hace push.service.js#sendToUser() en PR-B, no
    // este archivo) o explícitamente vía DELETE /push/unregister.
    isActive:   { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Único por {user, token} — si el mismo dispositivo se re-registra (ej.
// reinstall, o simplemente FCM le refresca el token), el POST de arriba
// hace upsert sobre esta clave en vez de acumular filas duplicadas.
pushTokenSchema.index({ user: 1, token: 1 }, { unique: true });
// Para push.service.js#sendToUser() (PR-B): buscar rápido los tokens
// activos de un usuario sin escanear los desactivados.
pushTokenSchema.index({ user: 1, isActive: 1 });

module.exports = mongoose.model('PushToken', pushTokenSchema);
module.exports.PLATFORMS = PLATFORMS;
