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
// GET /automations/status — límite del plan + activas ahora mismo, para el
// candado/CTA del frontend. Debe ir antes de '/:automationId' para no chocar.
router.get('/status', checkPermission('leads:read'), controller.status);
// GET /automations/limit — mismo dato que /status, shape {current, limit,
// allowed} para el candado de plan del frontend (Lovable). Ver comentario
// en automation.controller.js#limit — no es un cálculo nuevo, es
// status() con las keys traducidas. También antes de '/:automationId'.
router.get('/limit', checkPermission('leads:read'), controller.limit);

// Rutas con :automationId
router.get('/:automationId',         checkPermission('leads:read'),   controller.get);
router.patch('/:automationId',       checkPermission('leads:update'), controller.update);
router.delete('/:automationId',      checkPermission('leads:delete'), controller.remove);
router.patch('/:automationId/toggle',checkPermission('leads:update'), controller.toggle);
router.get('/:automationId/logs',    checkPermission('leads:read'),   controller.getLogs);
router.post('/:automationId/test',    checkPermission('leads:update'), controller.test);
router.post('/:automationId/execute', checkPermission('leads:update'), controller.test); // alias semántico

module.exports = router;
