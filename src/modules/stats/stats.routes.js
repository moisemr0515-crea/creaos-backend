const { Router } = require('express');
const controller = require('./stats.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

const router = Router();

router.use(authenticate, injectTenant);

// GET /api/v1/stats/summary — Owner, Admin, Manager y Viewer (reports:read). Sales queda fuera: `sales` no guarda vendedor,
// así que no se podría acotar a "solo sus ventas".
router.get('/summary', checkPermission('reports:read'), controller.getSummary);

module.exports = router;
