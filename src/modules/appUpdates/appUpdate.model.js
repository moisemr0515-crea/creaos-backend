const mongoose = require('mongoose');

// Solo 'android' hace falta hoy (integración de capacitor-updater) — 'ios'
// queda contemplado para no tener que tocar el schema el día que exista
// una versión iOS, mismo criterio que PushToken.PLATFORMS.
const PLATFORMS = ['android', 'ios'];

const appBundleSchema = new mongoose.Schema(
  {
    platform: { type: String, enum: PLATFORMS, required: true, index: true },
    // Permite tener, por ejemplo, un canal "beta" para probar un bundle
    // antes de promoverlo a "production" — capacitor-updater soporta esto
    // nativamente vía el campo `channel` que manda en cada check.
    channel: { type: String, default: 'production', trim: true, index: true },
    version: { type: String, required: true, trim: true },
    // Nombre del archivo .zip dentro de APP_UPDATES_DIR — NUNCA se arma a
    // partir de un valor que llegue del cliente (ver
    // appUpdate.service.js#nombrarArchivo()), evita cualquier chance de
    // path traversal en la descarga.
    filename: { type: String, required: true, unique: true },
    checksumSha256: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    // Soft-deactivate, nunca hard-delete — mismo criterio que el resto del
    // repo. publishBundle() desactiva el bundle activo anterior del mismo
    // {platform, channel} al publicar uno nuevo, así buscarActualizacion()
    // nunca tiene que decidir entre dos activos a la vez.
    isActive: { type: Boolean, default: true, index: true },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// Para buscarActualizacion(): un solo find por {platform, channel, isActive}, sin escanear versiones viejas.
appBundleSchema.index({ platform: 1, channel: 1, isActive: 1 });

module.exports = mongoose.model('AppBundle', appBundleSchema);
module.exports.PLATFORMS = PLATFORMS;
