const { Router } = require('express');
const controller = require('./whatsapp.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { requireCapability } = require('../../middleware/entitlement.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// Fix 2 (Caso 8): status real del canal (env vars de Gupshup), no simulado.
// checkPermission('leads:read') porque cualquiera que vea el chat de un lead
// necesita saber si el canal está disponible, no solo quien administra settings.
router.get('/status', checkPermission('leads:read'), requireCapability('whatsappEnabled'), controller.getStatus);

// Ventana de 24h de WhatsApp Business — checkPermission('leads:update') en
// vez de 'leads:read' porque listar plantillas solo tiene sentido para quien
// puede escribirle a un lead (mismo permiso que sendAgentMessage/toggle-ai).
router.get('/templates', checkPermission('leads:update'), requireCapability('whatsappEnabled'), controller.getTemplates);

module.exports = router;
