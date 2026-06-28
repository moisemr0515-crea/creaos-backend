const { Router } = require('express');
const controller = require('./lead.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { AppError } = require('../../middleware/error.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// Permite acceso a quien tenga leads:read o leads:own (SALES)
const checkLeadsAccess = (req, res, next) => {
  const perms = req.user?.role?.permissions || [];
  const slug = req.user?.role?.slug;
  if (slug === 'superadmin' || perms.includes('leads:read') || perms.includes('leads:own')) {
    return next();
  }
  next(new AppError('No tienes permiso para acceder a leads', 403));
};

// Bulk action va antes de /:id para evitar conflictos de ruta
router.post('/bulk', checkPermission('leads:update'), controller.bulkAction);

router.get('/', checkLeadsAccess, controller.listLeads);
router.post('/', checkPermission('leads:create'), controller.createLead);
router.get('/:id', checkLeadsAccess, controller.getLead);
router.put('/:id', checkPermission('leads:update'), controller.updateLead);
router.delete('/:id', checkPermission('leads:delete'), controller.deleteLead);

router.post('/:id/notes', checkPermission('leads:update'), controller.addNote);
router.put('/:id/stage', checkPermission('leads:update'), controller.changeStage);
router.put('/:id/assign', checkPermission('leads:update'), controller.assignLead);

module.exports = router;
