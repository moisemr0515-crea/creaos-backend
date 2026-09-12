const { Router } = require('express');
const multer = require('multer');
const controller = require('./product.controller');
const importController = require('./productImport.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { AppError } = require('../../middleware/error.middleware');

// CREA Product Intelligence™ V1.0 — Etapa 3/10. Solo el CRUD de gestión
// manual (documento maestro §9) — los 3 endpoints conceptuales de
// search/stock/price del §24 del documento NO se exponen acá: son
// consumidos por las tools de la IA (Etapa 6) directamente contra
// product.service.js, en el mismo proceso, sin una vuelta HTTP de por
// medio (mismo criterio que ya usan escalate_to_human/update_lead_stage,
// ver ai/tools/index.js) — así el `businessId` que reciben esas 3 funciones
// es siempre el `context.business._id` ya resuelto por generateReply(),
// nunca uno que un cliente HTTP pueda enviar. Si en una etapa futura hiciera
// falta un buscador manual en el panel de admin, GET /?search= (más abajo)
// ya cubre ese caso reusando listarProductos().
const router = Router();

// Etapa 5/10 — mismo multer que imports/import.routes.js (Leads): memoria,
// 5MB, CSV/XLSX/XLS. No se extrajo a un util compartido a propósito — es
// una config chica y estable, y hacerlo hubiera significado tocar un
// módulo (imports/) fuera del alcance de esta etapa solo para ahorrarse
// duplicar ~10 líneas.
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

router.get('/', checkPermission('products:read'), controller.listProducts);
router.post('/', checkPermission('products:create'), controller.createProduct);

// Preview requiere solo lectura (no persiste nada); confirmar sí requiere
// permiso de creación, igual que un alta manual — documento §10.2: "NO
// importar automáticamente sin confirmación".
router.post('/import/preview', checkPermission('products:read'), uploadImportFile.single('file'), importController.previewImport);
router.post('/import/confirm', checkPermission('products:create'), uploadImportFile.single('file'), importController.confirmImport);

router.get('/:id', checkPermission('products:read'), controller.getProduct);
router.put('/:id', checkPermission('products:update'), controller.updateProduct);
router.delete('/:id', checkPermission('products:delete'), controller.deactivateProduct);

module.exports = router;
