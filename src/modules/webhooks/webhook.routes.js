const { Router } = require('express');
const controller = require('./webhook.controller');
const subController = require('../subscriptions/subscription.controller');
const channelOnboardingWebhookController = require('../channels/channelOnboardingWebhook.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

// ─── Public routes (no auth) — called by Meta / TikTok / WhatsApp platforms ──
router.get('/meta',       controller.metaVerify);
router.post('/meta',      controller.metaWebhook);
router.get('/meta/oauth/callback', controller.metaOauthCallback);
router.get('/tiktok',     controller.tiktokVerify);
router.post('/tiktok',    controller.tiktokWebhook);
router.get('/whatsapp',   controller.whatsappVerify);
router.post('/whatsapp',  controller.whatsappWebhook);
router.get('/gupshup',    controller.gupshupVerify);
router.post('/gupshup',   controller.gupshupWebhook);

// Callback DEDICADO de la suscripción ACCOUNT del Embedded Signup (canales
// DEDICATED) — a propósito NO es /gupshup a secas (ver
// channelOnboardingWebhook.controller.js, incidente del 04/sep/2026,
// docs/implementation/known-issues.md Bug 3): ese endpoint ya tiene tráfico
// real de PLATFORM y exige GUPSHUP_WEBHOOK_TOKEN en todo POST, cosa que el
// ping de verificación de Gupshup al crear una suscripción nueva no puede
// conocer. Token propio (GUPSHUP_ONBOARDING_WEBHOOK_TOKEN), sin tocar el
// endpoint de arriba.
router.get('/gupshup/onboarding/:appId',  channelOnboardingWebhookController.verify);
router.post('/gupshup/onboarding/:appId', channelOnboardingWebhookController.webhook);

// ─── Public routes — payment providers ───────────────────────────────────────
router.post('/stripe',       subController.stripeWebhook);
router.post('/mercadopago',  subController.mercadopagoWebhook);

// ─── Protected routes — manage webhook configs ────────────────────────────────
router.use(authenticate, injectTenant);

router.get('/meta/oauth/connect',    checkPermission('businesses:settings'), controller.metaOauthConnect);
router.post('/meta/oauth/disconnect', checkPermission('businesses:settings'), controller.metaOauthDisconnect);

router.post('/configs',              checkPermission('leads:create'), controller.createConfig);
router.get('/configs',               checkPermission('leads:read'),   controller.listConfigs);
router.get('/configs/:configId',     checkPermission('leads:read'),   controller.getConfig);
router.patch('/configs/:configId',   checkPermission('leads:update'), controller.updateConfig);
router.delete('/configs/:configId',  checkPermission('leads:delete'), controller.deleteConfig);
router.post('/configs/:configId/test', checkPermission('leads:read'), controller.testWebhook);

module.exports = router;
