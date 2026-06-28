const { Router } = require('express');
const multer = require('multer');
const controller = require('./import.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { AppError } = require('../../middleware/error.middleware');

const router = Router();

const upload = multer({
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

router.post('/', checkPermission('leads:create'), upload.single('file'), controller.uploadImport);
router.get('/', checkPermission('leads:read'), controller.listImports);
router.get('/:id', checkPermission('leads:read'), controller.getImport);

module.exports = router;
