const { Router } = require('express');
const controller = require('./ai.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// Rutas sin :conversationId (antes para evitar conflictos)
router.post('/suggest', checkPermission('leads:update'), controller.suggestResponse);
router.post('/',        checkPermission('leads:create'), controller.startConversation);
router.get('/',         checkPermission('leads:read'),   controller.listConversations);

// Rutas con :conversationId
router.get('/:conversationId',               checkPermission('leads:read'),   controller.getConversation);
router.post('/:conversationId/message',      checkPermission('leads:update'), controller.sendMessage);
router.post('/:conversationId/qualify',      checkPermission('leads:update'), controller.qualifyLead);
router.post('/:conversationId/summary',      checkPermission('leads:update'), controller.getSummary);
router.patch('/:conversationId/toggle-ai',   checkPermission('leads:update'), controller.toggleAI);
router.patch('/:conversationId/escalate',    checkPermission('leads:update'), controller.escalate);

module.exports = router;
