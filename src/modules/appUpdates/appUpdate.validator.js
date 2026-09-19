const Joi = require('joi');
const { PLATFORMS } = require('./appUpdate.model');

// Semver simple (X.Y.Z, sin pre-release) — todo lo que necesita
// capacitor-updater para comparar versiones. No usa una lib de semver
// completa a propósito: la comparación real la hace buscarActualizacion()
// por igualdad de string contra el bundle activo, no por orden semántico.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

// POST /api/v1/app-updates/check — payload que manda capacitor-updater en
// cada arranque de la app (ver AppInfos en la documentación del plugin).
// stripUnknown en validateBody() descarta el resto de los campos que el
// plugin manda y que no usamos (plugin_version, is_emulator, etc.).
const checkUpdateSchema = Joi.object({
  platform: Joi.string().valid(...PLATFORMS).required(),
  // "builtin" es el valor que manda el plugin cuando la app corre el
  // bundle empaquetado en el AAB, sin ningún update aplicado todavía.
  version_name: Joi.string().trim().max(50).allow('', null).default('builtin'),
  channel: Joi.string().trim().max(50).allow('', null).default('production'),
}).unknown(true);

// POST /api/v1/app-updates/publish — multipart/form-data, este schema
// valida los campos de texto (req.body); el archivo llega aparte vía
// multer (req.file), validado por separado en el controller.
const publishBundleSchema = Joi.object({
  platform: Joi.string().valid(...PLATFORMS).required(),
  version: Joi.string().trim().pattern(SEMVER_PATTERN).required()
    .messages({ 'string.pattern.base': 'version debe tener formato X.Y.Z (ej. 1.0.1)' }),
  channel: Joi.string().trim().max(50).default('production'),
});

module.exports = { checkUpdateSchema, publishBundleSchema, SEMVER_PATTERN };
