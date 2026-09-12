const { Router } = require('express');
const controller = require('./faq.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11. Ver
// policy.routes.js para el criterio compartido (no se repite acá).
const router = Router();

router.use(authenticate, injectTenant);

router.get('/', checkPermission('faqs:read'), controller.listFAQs);
router.post('/', checkPermission('faqs:create'), controller.createFAQ);

router.get('/:id', checkPermission('faqs:read'), controller.getFAQ);
router.put('/:id', checkPermission('faqs:update'), controller.updateFAQ);
router.delete('/:id', checkPermission('faqs:delete'), controller.archiveFAQ);

module.exports = router;
