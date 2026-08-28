const { Router } = require('express');
const controller = require('./channel.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

// channel.routes.js — primera vez que el módulo channels/ expone rutas HTTP
// propias (PR-03, blueprint maestro §19). Solo el endpoint de init por
// ahora — el resto (callback, complete, status, list, disconnect) llega en
// PRs posteriores, ver docs/implementation/fase-2.1-blueprint-final.md §4.

const router = Router();

router.use(authenticate, injectTenant);

// businesses:settings — mismo permiso que usaba POST /whatsapp/connections
// (el flujo que este endpoint reemplaza) y metaOauthConnect/Disconnect.
router.post('/whatsapp/embedded-signup/init', checkPermission('businesses:settings'), controller.initEmbeddedSignup);

module.exports = router;
