const { Router } = require('express');
const controller = require('./auth.controller');
const {
  validarRegistro,
  validarLogin,
  validarForgotPassword,
  validarResetPassword,
  validarVerifyEmail,
} = require('./auth.validator');
const { validate } = require('../../middleware/validate.middleware');
const {
  rateLimitAuthGeneral,
  rateLimitLogin,
  rateLimitForgotPassword,
  rateLimitRegister,
} = require('../../middleware/rateLimit.middleware');

const router = Router();

// Balde propio de /auth/*, separado del de recursos de negocio — ver
// rateLimitAuthGeneral() en rateLimit.middleware.js (Bloque A del
// diagnóstico post-hardening). Corre para TODAS las rutas de este router,
// ADEMÁS de (no en reemplazo de) los limiters específicos de abajo.
router.use(rateLimitAuthGeneral);

// POST /api/v1/auth/register
router.post('/register', rateLimitRegister, validarRegistro, validate, controller.register);

// POST /api/v1/auth/login
router.post('/login', rateLimitLogin, validarLogin, validate, controller.login);

// POST /api/v1/auth/logout — la cookie HttpOnly identifica la sesión incluso
// si el access token ya expiró.
router.post('/logout', controller.logout);

// POST /api/v1/auth/refresh
router.post('/refresh', controller.refresh);

// POST /api/v1/auth/forgot-password
router.post('/forgot-password', rateLimitForgotPassword, validarForgotPassword, validate, controller.forgotPassword);

// POST /api/v1/auth/reset-password
router.post('/reset-password', validarResetPassword, validate, controller.resetPassword);

// POST /api/v1/auth/verify-email
router.post('/verify-email', validarVerifyEmail, validate, controller.verifyEmail);

module.exports = router;
