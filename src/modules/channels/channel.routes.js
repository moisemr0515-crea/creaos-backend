const { Router } = require('express');
const controller = require('./channel.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

// channel.routes.js — módulo channels/ (PR-03 §19 init; PR-04 §21-22 Meta
// Callback: /code + /callback; PR-05 §55 Gupshup Registration:
// /complete-gupshup). El resto (status, list, disconnect, y la creación
// real del WhatsAppChannel) llega en PRs posteriores, ver
// docs/implementation/fase-2.1-blueprint-final.md §4.

const router = Router();

router.use(authenticate, injectTenant);

// businesses:settings — mismo permiso que usaba POST /whatsapp/connections
// (el flujo que este endpoint reemplaza) y metaOauthConnect/Disconnect, en
// los 4 pasos del onboarding.
router.post('/whatsapp/embedded-signup/init', checkPermission('businesses:settings'), controller.initEmbeddedSignup);
router.post('/whatsapp/embedded-signup/code', checkPermission('businesses:settings'), controller.codeEmbeddedSignup);
router.post('/whatsapp/embedded-signup/callback', checkPermission('businesses:settings'), controller.callbackEmbeddedSignup);
router.post('/whatsapp/embedded-signup/complete-gupshup', checkPermission('businesses:settings'), controller.completeGupshupEmbeddedSignup);

module.exports = router;
