const { Router } = require('express');
const controller      = require('./subscription.controller');
const { authenticate }    = require('../../middleware/auth.middleware');
const { injectTenant }    = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

// Mercado Pago vuelve desde un navegador externo: el retorno es público y
// solo informa UX. No concede entitlement ni necesita una sesión.
router.get('/mp/callback', controller.mpCallback);

// ─── Rutas protegidas ─────────────────────────────────────────────────────────
router.use(authenticate, injectTenant);

router.get('/plans',                   controller.getPlans);
router.get('/current',                 controller.getCurrentSubscription);
router.get('/leads/limit',             controller.checkLeadLimit);
router.post('/stripe/subscribe',       checkPermission('leads:create'), controller.stripeSubscribe);
router.post('/mercadopago/subscribe',  checkPermission('leads:create'), controller.mercadopagoSubscribe);
router.post('/cancel',                 checkPermission('leads:delete'), controller.cancelSubscription);

module.exports = router;
