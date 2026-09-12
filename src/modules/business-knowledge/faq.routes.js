const { Router } = require('express');
const multer = require('multer');
const controller = require('./faq.controller');
const importController = require('./faqImport.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { AppError } = require('../../middleware/error.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11. Ver
// policy.routes.js para el criterio compartido (no se repite acá).
const router = Router();

// Etapa 9/11 — mismo multer que policy.routes.js/product.routes.js.
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

router.get('/', checkPermission('faqs:read'), controller.listFAQs);
router.post('/', checkPermission('faqs:create'), controller.createFAQ);

router.post('/import/preview', checkPermission('faqs:read'), uploadImportFile.single('file'), importController.previewImport);
router.post('/import/confirm', checkPermission('faqs:create'), uploadImportFile.single('file'), importController.confirmImport);

router.get('/:id', checkPermission('faqs:read'), controller.getFAQ);
router.put('/:id', checkPermission('faqs:update'), controller.updateFAQ);
router.delete('/:id', checkPermission('faqs:delete'), controller.archiveFAQ);

module.exports = router;
