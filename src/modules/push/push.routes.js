const { Router } = require('express');
const controller = require('./push.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { injectTenant } = require('../../middleware/tenant.middleware');

const router = Router();

// Personal — cada usuario administra sus propios tokens de dispositivo, no
// hace falta un permiso de rol específico (mismo criterio que
// /users/me: authenticate + injectTenant, sin checkPermission).
router.use(authenticate, injectTenant);

router.post('/register', controller.register);
router.delete('/unregister', controller.unregister);

module.exports = router;
