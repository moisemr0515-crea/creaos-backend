const { Router } = require('express');
const controller = require('./pipeline.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// /default antes de /:id para evitar que "default" se interprete como id
router.get('/default', checkPermission('pipeline:read'), controller.getDefault);

router.get('/', checkPermission('pipeline:read'), controller.listPipelines);
router.post('/', checkPermission('pipeline:update'), controller.createPipeline);
router.get('/:id', checkPermission('pipeline:read'), controller.getPipeline);
router.put('/:id', checkPermission('pipeline:update'), controller.updatePipeline);
router.get('/:id/board', checkPermission('pipeline:read'), controller.getBoard);

module.exports = router;
