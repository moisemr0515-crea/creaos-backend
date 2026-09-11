const { Router } = require('express');
const controller = require('./product.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');
const { checkPermission } = require('../../middleware/rbac.middleware');

// CREA Product Intelligence™ V1.0 — Etapa 3/10. Solo el CRUD de gestión
// manual (documento maestro §9) — los 3 endpoints conceptuales de
// search/stock/price del §24 del documento NO se exponen acá: son
// consumidos por las tools de la IA (Etapa 6) directamente contra
// product.service.js, en el mismo proceso, sin una vuelta HTTP de por
// medio (mismo criterio que ya usan escalate_to_human/update_lead_stage,
// ver ai/tools/index.js) — así el `businessId` que reciben esas 3 funciones
// es siempre el `context.business._id` ya resuelto por generateReply(),
// nunca uno que un cliente HTTP pueda enviar. Si en una etapa futura hiciera
// falta un buscador manual en el panel de admin, GET /?search= (más abajo)
// ya cubre ese caso reusando listarProductos().
const router = Router();

router.use(authenticate, injectTenant);

router.get('/', checkPermission('products:read'), controller.listProducts);
router.post('/', checkPermission('products:create'), controller.createProduct);
router.get('/:id', checkPermission('products:read'), controller.getProduct);
router.put('/:id', checkPermission('products:update'), controller.updateProduct);
router.delete('/:id', checkPermission('products:delete'), controller.deactivateProduct);

module.exports = router;
