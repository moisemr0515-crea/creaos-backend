const { Router } = require('express');
const controller = require('./webhook.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

// ─── Public routes (no auth) — called by Meta / TikTok platforms ─────────────
router.get('/meta',    controller.metaVerify);
router.post('/meta',   controller.metaWebhook);
router.get('/tiktok',  controller.tiktokVerify);
router.post('/tiktok', controller.tiktokWebhook);

// ─── Protected routes — manage webhook configs ────────────────────────────────
router.use(authenticate, injectTenant);

router.post('/configs',              checkPermission('leads:create'), controller.createConfig);
router.get('/configs',               checkPermission('leads:read'),   controller.listConfigs);
router.get('/configs/:configId',     checkPermission('leads:read'),   controller.getConfig);
router.patch('/configs/:configId',   checkPermission('leads:update'), controller.updateConfig);
router.delete('/configs/:configId',  checkPermission('leads:delete'), controller.deleteConfig);
router.post('/configs/:configId/test', checkPermission('leads:read'), controller.testWebhook);

module.exports = router;
