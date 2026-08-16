const { Router } = require('express');
const multer = require('multer');
const controller = require('./ai.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { AppError } = require('../../middleware/error.middleware');

const router = Router();

// Mismo patrón que business.routes.js (multer en memoria + subirBuffer en
// el service) — límite de 16MB (el máximo real de WhatsApp, para video;
// imágenes son 5MB pero se valida un solo límite más simple, el tipo real
// SÍ se restringe por mimetype a lo que WhatsApp/Meta soporta).
const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimeOk = ['image/jpeg', 'image/png', 'video/mp4', 'video/3gpp'].includes(file.mimetype);
    if (mimeOk) cb(null, true);
    else cb(new AppError('Tipo de archivo no permitido. Use JPG, PNG (imagen) o MP4, 3GPP (video)', 400));
  },
});

router.use(authenticate, injectTenant);

// Rutas sin :conversationId (antes para evitar conflictos)
router.post('/suggest', checkPermission('leads:update'), controller.suggestResponse);
router.post('/',        checkPermission('leads:create'), controller.startConversation);
router.get('/',         checkPermission('leads:read'),   controller.listConversations);

// Rutas con :conversationId
router.get('/:conversationId',               checkPermission('leads:read'),   controller.getConversation);
router.post('/:conversationId/message',      checkPermission('leads:update'), controller.sendMessage);
router.post('/:conversationId/agent-message', checkPermission('leads:update'), controller.sendAgentMessage);
router.post('/:conversationId/template-message', checkPermission('leads:update'), controller.sendTemplateMessage);
router.post('/:conversationId/media-message', checkPermission('leads:update'), uploadMedia.single('media'), controller.sendMediaMessage);
router.post('/:conversationId/qualify',      checkPermission('leads:update'), controller.qualifyLead);
router.post('/:conversationId/summary',      checkPermission('leads:update'), controller.getSummary);
router.patch('/:conversationId/toggle-ai',   checkPermission('leads:update'), controller.toggleAI);
router.patch('/:conversationId/escalate',    checkPermission('leads:update'), controller.escalate);

module.exports = router;
