const { Router } = require('express');
const controller = require('./mission.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { rateLimitMissionRegenerate } = require('../../middleware/rateLimit.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// GET /api/v1/missions/today — lectura, mismo permiso que ver leads (todos los roles lo tienen)
router.get('/today', checkPermission('leads:read'), controller.getMisionDeHoy);

// POST /api/v1/missions/regenerate — dispara una llamada a GPT-4o (cuesta dinero),
// requiere permiso de escritura sobre leads + rate limit por negocio.
router.post('/regenerate', checkPermission('leads:update'), rateLimitMissionRegenerate, controller.regenerarMision);

module.exports = router;
