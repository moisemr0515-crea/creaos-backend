const { Router } = require('express');
const { body } = require('express-validator');
const controller = require('./business.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { validate } = require('../../middleware/validate.middleware');

const router = Router();

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
