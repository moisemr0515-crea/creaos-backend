const { Router } = require('express');
const controller = require('./policy.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11 (CRUD
// API + RBAC). RBAC granular `policies:*` — decisión confirmada en
// docs/implementation/c2-policies-faq-current-state.md (sección 6, decisión
// #1): mismo nivel de granularidad que el resto del RBAC del proyecto
// (products:read/create/update/delete), NO un "business-knowledge:*"
// unificado.
const router = Router();

router.use(authenticate, injectTenant);

router.get('/', checkPermission('policies:read'), controller.listPolicies);
router.post('/', checkPermission('policies:create'), controller.createPolicy);

router.get('/:id', checkPermission('policies:read'), controller.getPolicy);
router.put('/:id', checkPermission('policies:update'), controller.updatePolicy);
router.delete('/:id', checkPermission('policies:delete'), controller.archivePolicy);

module.exports = router;
