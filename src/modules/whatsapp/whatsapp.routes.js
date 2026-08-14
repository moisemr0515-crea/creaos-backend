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

// Fix 2 (Caso 8): status real del canal (env vars de Gupshup), no simulado.
// checkPermission('leads:read') porque cualquiera que vea el chat de un lead
// necesita saber si el canal está disponible, no solo quien administra settings.
router.get('/status', checkPermission('leads:read'), controller.getStatus);

module.exports = router;
