const { Router } = require('express');
const multer = require('multer');
const controller = require('./policy.controller');
const importController = require('./policyImport.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { AppError } = require('../../middleware/error.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11 (CRUD
// API + RBAC). RBAC granular `policies:*` — decisión confirmada en
// docs/implementation/c2-policies-faq-current-state.md (sección 6, decisión
// #1): mismo nivel de granularidad que el resto del RBAC del proyecto
// (products:read/create/update/delete), NO un "business-knowledge:*"
// unificado.
const router = Router();

// Etapa 9/11 — mismo multer EXACTO que product.routes.js (memoria, 5MB,
// CSV/XLSX/XLS). No se extrajo a un util compartido, mismo criterio ya
// documentado ahí: config chica y estable, no vale la pena tocar un
// módulo fuera de alcance solo para no duplicar ~10 líneas.
const uploadImportFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    const mimeOk = [
      'text/csv',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ].includes(file.mimetype);

    if (extOk || mimeOk) {
      cb(null, true);
    } else {
      cb(new AppError('Tipo de archivo no permitido. Use CSV, XLSX o XLS', 400));
    }
  },
});

router.use(authenticate, injectTenant);

router.get('/', checkPermission('policies:read'), controller.listPolicies);
router.post('/', checkPermission('policies:create'), controller.createPolicy);

// Mismo criterio que product.routes.js: preview requiere solo lectura (no
// persiste nada), confirmar requiere permiso de creación, igual que un
// alta manual.
router.post('/import/preview', checkPermission('policies:read'), uploadImportFile.single('file'), importController.previewImport);
router.post('/import/confirm', checkPermission('policies:create'), uploadImportFile.single('file'), importController.confirmImport);

router.get('/:id', checkPermission('policies:read'), controller.getPolicy);
router.put('/:id', checkPermission('policies:update'), controller.updatePolicy);
router.delete('/:id', checkPermission('policies:delete'), controller.archivePolicy);

module.exports = router;
