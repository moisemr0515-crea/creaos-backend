const { Router } = require('express');
const controller = require('./whatsapp.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

router.use(authenticate, injectTenant);

router.post('/connections',     checkPermission('businesses:settings'), controller.createConnection);
router.get('/connections',      checkPermission('businesses:settings'), controller.listConnections);
router.delete('/connections/:id', checkPermission('businesses:settings'), controller.disconnectConnection);

module.exports = router;
