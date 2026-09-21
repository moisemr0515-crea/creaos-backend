const { Router } = require('express');
const multer = require('multer');
const { body } = require('express-validator');
const controller = require('./business.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { AppError } = require('../../middleware/error.middleware');
const { traducirErroresDeMulter } = require('../../middleware/uploadErrors.middleware');
const { validarContenidoArchivo } = require('../../middleware/fileContentValidation.middleware');
const { requireCapability } = require('../../middleware/entitlement.middleware');

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

// send_media (auditoría de factibilidad, 12/sep/2026) — límites de tamaño
// EXACTOS a los que impone Meta/WhatsApp Business API para media saliente
// (developers.facebook.com/docs/whatsapp/cloud-api/reference/media,
// confirmado también contra la doc de Gupshup) — no son un criterio
// propio: un archivo que pase estos límites igual sería rechazado por
// WhatsApp al intentar reenviarlo.
const uploadVideoPresentacion = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB — límite real de Meta para video saliente
  fileFilter: (_req, file, cb) => {
    const mimeOk = ['video/mp4', 'video/3gpp'].includes(file.mimetype);
    if (mimeOk) cb(null, true);
    else cb(new AppError('Tipo de video no permitido. Use MP4 o 3GP', 400));
  },
});

const uploadBrochure = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — límite real de Meta para documento saliente
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
    // Nombre del agente de IA — separado de `name` (nombre del negocio).
    body('agentName').optional().trim().isLength({ max: 50 }).withMessage('Nombre del agente muy largo (máx 50 caracteres)'),
    body('email').optional().trim().isEmail().withMessage('Email inválido').normalizeEmail(),
    body('phone').optional().trim().isMobilePhone('any').withMessage('Teléfono inválido'),
    // checkFalsy:true (diagnóstico 19/sep/2026): sin esto, un "" (el valor
    // que manda business.tsx#saveAll() cuando el negocio no tiene sitio
    // web cargado, el caso normal) NO cuenta como "ausente" para
    // .optional() — isURL() corría igual sobre "" y tiraba 422, así que
    // TODO el PUT se rechazaba (validate.middleware.js corta antes del
    // controller), no solo este campo. Mismo criterio que
    // Business.model.js#esUrlValida (facebookUrl/instagramUrl/tiktokUrl),
    // que ya trataba "" como válido.
    body('website').optional({ checkFalsy: true }).trim().isURL().withMessage('URL inválida'),
    body('country').optional().trim().isLength({ min: 2, max: 3 }).withMessage('País inválido'),
    body('currency').optional().trim().isLength({ min: 3, max: 3 }).withMessage('Moneda inválida (ISO 4217)'),
    body('industry').optional().trim().isLength({ max: 100 }).withMessage('Industria muy larga'),
    // checkFalsy:true — mismo bug y mismo motivo que website (arriba):
    // saveAll() manda whatsappNumber:"" cuando el negocio todavía no
    // conectó WhatsApp — sin esto, CUALQUIER negocio sin WhatsApp conectado
    // tenía el PUT de "Guardar cambios" rechazado en bloque, sin importar
    // qué otro campo intentara cambiar.
    //
    // Frente 2 (19/sep/2026): el .matches(E.164) que vivía acá se movió a
    // Business.model.js#esWhatsappValido — mismo criterio que
    // facebookUrl/instagramUrl/tiktokUrl (esUrlValida), que ya validan a
    // nivel de schema, no de ruta. Acá solo queda la sanitización de
    // formato (espacios/guiones/paréntesis), no la validación en sí — un
    // valor mal formado ahora lo rechaza Business.findByIdAndUpdate()
    // (runValidators:true) con un ValidationError de Mongoose, que
    // error.middleware.js ya traduce a 400 con el mismo mensaje.
    body('whatsappNumber')
      .optional({ checkFalsy: true })
      .trim()
      .customSanitizer((valor) => (valor ? valor.replace(/[\s\-()]/g, '') : valor)),
    body('productDescription').optional().trim().isLength({ max: 500 }).withMessage('Descripción de producto muy larga'),
    body('averageTicket').optional().isFloat({ min: 0 }).withMessage('Ticket promedio debe ser un número >= 0'),
    body('targetCustomer').optional().trim().isLength({ max: 300 }).withMessage('Descripción de cliente objetivo muy larga'),
    body('aiInstructions').optional().trim().isLength({ max: 1500 }).withMessage('Instrucciones para la IA muy largas (máx 1500 caracteres)'),
    body('aiPersonality').optional().isIn(['cercano', 'formal', 'agresivo']).withMessage('aiPersonality debe ser cercano, formal o agresivo'),
    body('aiSalesEnabled').optional().isBoolean().withMessage('aiSalesEnabled debe ser booleano').toBoolean(),
  ],
  validate,
  requireCapability('aiEnabled', (req) => req.body.aiSalesEnabled === true),
  controller.updateNegocioActual
);

// GET /api/v1/businesses/current/assets/:campo/access
// P0 de seguridad (Bloque 1, 19/sep/2026) — acceso firmado con expiración
// real en vez de la URL pública permanente guardada en el negocio.
router.get('/current/assets/:campo/access',
  checkPermission('businesses:read'),
  controller.getAssetAccess
);

// POST /api/v1/businesses/current/logo
router.post('/current/logo',
  checkPermission('businesses:update'),
  traducirErroresDeMulter(uploadImagen.single('logo'), { campoLegible: 'el logo', limiteLegible: '5MB' }),
  validarContenidoArchivo(['jpeg', 'png', 'webp']),
  controller.uploadLogo
);

// POST /api/v1/businesses/current/photos  (hasta 2 fotos de producto)
router.post('/current/photos',
  checkPermission('businesses:update'),
  traducirErroresDeMulter(uploadImagen.array('photos', 2), { campoLegible: 'las fotos de producto', limiteLegible: '5MB' }),
  validarContenidoArchivo(['jpeg', 'png', 'webp']),
  controller.uploadPhotos
);

// POST /api/v1/businesses/current/pdf  (extrae texto para la IA de ventas)
router.post('/current/pdf',
  checkPermission('businesses:update'),
  traducirErroresDeMulter(uploadPdf.single('pdf'), { campoLegible: 'el PDF informativo', limiteLegible: '10MB' }),
  validarContenidoArchivo(['pdf']),
  controller.uploadPdf
);

// POST /api/v1/businesses/current/presentation-video  (para reenviar por WhatsApp, send_media)
router.post('/current/presentation-video',
  checkPermission('businesses:update'),
  traducirErroresDeMulter(uploadVideoPresentacion.single('video'), { campoLegible: 'video de presentación', limiteLegible: '16MB' }),
  validarContenidoArchivo(['mp4', '3gp']),
  controller.uploadPresentationVideo
);

// POST /api/v1/businesses/current/brochure  (para reenviar por WhatsApp, send_media — distinto del PDF de conocimiento de arriba)
router.post('/current/brochure',
  checkPermission('businesses:update'),
  traducirErroresDeMulter(uploadBrochure.single('brochure'), { campoLegible: 'el brochure', limiteLegible: '100MB' }),
  validarContenidoArchivo(['pdf']),
  controller.uploadBrochure
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
