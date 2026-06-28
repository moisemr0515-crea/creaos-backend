const { Router } = require('express');
const { body, query } = require('express-validator');
const controller = require('./user.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission, checkRole } = require('../../middleware/rbac.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { ROLES } = require('../../config/constants');

const router = Router();

// Todas las rutas de usuarios requieren autenticación y tenant
router.use(authenticate, injectTenant);

// ─── MI PERFIL ────────────────────────────────────────────────────────────────

// GET /api/v1/users/me
router.get('/me', controller.getMiPerfil);

// PUT /api/v1/users/me
router.put('/me',
  [
    body('name').optional().trim().isLength({ min: 2, max: 80 }).withMessage('Nombre inválido'),
    body('phone').optional().trim().isMobilePhone('any').withMessage('Teléfono inválido'),
    body('avatar').optional().trim().isURL().withMessage('URL de avatar inválida'),
  ],
  validate,
  controller.updateMiPerfil
);

// PUT /api/v1/users/security
router.put('/security',
  [
    body('currentPassword').notEmpty().withMessage('La contraseña actual es requerida'),
    body('newPassword')
      .isLength({ min: 8 }).withMessage('La nueva contraseña debe tener al menos 8 caracteres')
      .matches(/[A-Z]/).withMessage('Debe contener al menos una mayúscula')
      .matches(/[0-9]/).withMessage('Debe contener al menos un número'),
  ],
  validate,
  controller.updateSecurity
);

// ─── GESTIÓN DE USUARIOS (Admin+) ─────────────────────────────────────────────

// GET /api/v1/users
router.get('/',
  checkPermission('users:read'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Página inválida'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Límite inválido'),
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Búsqueda muy larga'),
  ],
  validate,
  controller.getUsuarios
);

// PUT /api/v1/users/:id
router.put('/:id',
  checkPermission('users:update'),
  [
    body('name').optional().trim().isLength({ min: 2, max: 80 }).withMessage('Nombre inválido'),
    body('phone').optional().trim().isMobilePhone('any').withMessage('Teléfono inválido'),
    body('roleId').optional().isMongoId().withMessage('ID de rol inválido'),
    body('isActive').optional().isBoolean().withMessage('isActive debe ser booleano'),
  ],
  validate,
  controller.updateUsuario
);

// DELETE /api/v1/users/:id (solo Owner)
router.delete('/:id',
  checkRole(ROLES.OWNER, ROLES.SUPER_ADMIN),
  controller.deleteUsuario
);

module.exports = router;
