const { Router } = require('express');
const controller = require('./automation.controller');
const { authenticate }    = require('../../middleware/auth.middleware');
const { injectTenant }    = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// Rutas sin :automationId (antes para evitar conflictos)
router.post('/', checkPermission('leads:create'), controller.create);
router.get('/',  checkPermission('leads:read'),   controller.list);

// Rutas con :automationId
router.get('/:automationId',         checkPermission('leads:read'),   controller.get);
router.patch('/:automationId',       checkPermission('leads:update'), controller.update);
router.delete('/:automationId',      checkPermission('leads:delete'), controller.remove);
router.patch('/:automationId/toggle',checkPermission('leads:update'), controller.toggle);
router.get('/:automationId/logs',    checkPermission('leads:read'),   controller.getLogs);
router.post('/:automationId/test',    checkPermission('leads:update'), controller.test);
router.post('/:automationId/execute', checkPermission('leads:update'), controller.test); // alias semántico

module.exports = router;
