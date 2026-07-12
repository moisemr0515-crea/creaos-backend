const { Router } = require('express');
const multer = require('multer');
const { body } = require('express-validator');
const controller = require('./business.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { AppError } = require('../../middleware/error.middleware');

const router = Router();

const uploadImagen = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const mimeOk = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (mimeOk) cb(null, true);
    else cb(new AppError('Tipo de imagen no permitido. Use JPG, PNG o WEBP', 400));
  },
});

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const extOk = /\.pdf$/i.test(file.originalname);
    const mimeOk = file.mimetype === 'application/pdf';
    if (extOk || mimeOk) cb(null, true);
    else cb(new AppError('Solo se permiten archivos PDF', 400));
  },
});

// Todas las rutas requieren autenticación y tenant
router.use(authenticate, injectTenant);

// GET /api/v1/businesses/current
router.get('/current', checkPermission('businesses:read'), controller.getNegocioActual);

// PUT /api/v1/businesses/current
router.put('/current',
  checkPermission('businesses:update'),
  [
    body('name').optional().trim().isLength({ min: 2, max: 100 }).withMessage('Nombre inválido'),
    body('email').optional().trim().isEmail().withMessage('Email inválido').normalizeEmail(),
    body('phone').optional().trim().isMobilePhone('any').withMessage('Teléfono inválido'),
    body('website').optional().trim().isURL().withMessage('URL inválida'),
    body('country').optional().trim().isLength({ min: 2, max: 3 }).withMessage('País inválido'),
    body('currency').optional().trim().isLength({ min: 3, max: 3 }).withMessage('Moneda inválida (ISO 4217)'),
    body('industry').optional().trim().isLength({ max: 100 }).withMessage('Industria muy larga'),
    body('whatsappNumber').optional().trim().isMobilePhone('any').withMessage('Número de WhatsApp inválido'),
    body('productDescription').optional().trim().isLength({ max: 500 }).withMessage('Descripción de producto muy larga'),
    body('averageTicket').optional().isFloat({ min: 0 }).withMessage('Ticket promedio debe ser un número >= 0'),
    body('targetCustomer').optional().trim().isLength({ max: 300 }).withMessage('Descripción de cliente objetivo muy larga'),
  ],
  validate,
  controller.updateNegocioActual
);

// POST /api/v1/businesses/current/logo
router.post('/current/logo',
  checkPermission('businesses:update'),
  uploadImagen.single('logo'),
  controller.uploadLogo
);

// POST /api/v1/businesses/current/photos  (hasta 2 fotos de producto)
router.post('/current/photos',
  checkPermission('businesses:update'),
  uploadImagen.array('photos', 2),
  controller.uploadPhotos
);

// POST /api/v1/businesses/current/pdf  (extrae texto para la IA de ventas)
router.post('/current/pdf',
  checkPermission('businesses:update'),
  uploadPdf.single('pdf'),
  controller.uploadPdf
);

// PUT /api/v1/businesses/settings
router.put('/settings',
  checkPermission('businesses:settings'),
  [
    body('timezone').optional().trim().isString().withMessage('Timezone inválido'),
    body('language').optional().trim().isIn(['es', 'en', 'pt']).withMessage('Idioma no soportado (es, en, pt)'),
    body('notifications').optional().isObject().withMessage('Notificaciones debe ser un objeto'),
    body('notifications.email').optional().isBoolean().withMessage('notifications.email debe ser booleano'),
    body('notifications.whatsapp').optional().isBoolean().withMessage('notifications.whatsapp debe ser booleano'),
  ],
  validate,
  controller.updateSettings
);

module.exports = router;
