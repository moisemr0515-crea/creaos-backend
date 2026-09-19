const express = require('express');
const multer = require('multer');
const ctrl = require('./appUpdate.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { checkRole } = require('../../middleware/rbac.middleware');
const { traducirErroresDeMulter } = require('../../middleware/uploadErrors.middleware');
const { ROLES } = require('../../config/constants');

const router = express.Router();

// 80MB — margen amplio sobre el tamaño real de dist/client/ (unos pocos MB
// hoy), mismo criterio de "límite generoso pero no ilimitado" que ya usan
// los uploads de negocio (business.routes.js).
const uploadBundle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
}).single('bundle');

// Público a propósito — lo llama la app ANTES de cualquier login (arranque
// en frío), con device_id/app_id, no con un JWT de usuario. No es una ruta
// de negocio, es el mismo tipo de endpoint público que cualquier "check
// for updates" de un instalador de escritorio.
router.post('/check', ctrl.check);

// Público a propósito — el .zip no es secreto, es el propio código de la
// app (ver comentario en appUpdate.controller.js#download()).
router.get('/download/:filename', ctrl.download);

// Publicar un bundle nuevo SÍ requiere autenticación — reutiliza
// exactamente el mismo checkRole(SUPER_ADMIN) que ya protege las rutas
// globales de admin.routes.js (ej. /admin/organization/settings): esto no
// es una acción por-tenant, es contenido que se sirve a TODOS los
// dispositivos Android de todos los negocios.
router.post(
  '/publish',
  authenticate,
  checkRole(ROLES.SUPER_ADMIN),
  traducirErroresDeMulter(uploadBundle, { campoLegible: 'el bundle', limiteLegible: '80MB' }),
  ctrl.publish
);

module.exports = router;
