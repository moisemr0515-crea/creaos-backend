const { Router } = require('express');
const controller = require('./auth.controller');
const {
  validarRegistro,
  validarLogin,
  validarLogout,
  validarRefreshToken,
  validarForgotPassword,
  validarResetPassword,
  validarVerifyEmail,
} = require('./auth.validator');
const { validate } = require('../../middleware/validate.middleware');
const { authenticate } = require('../../middleware/auth.middleware');
const {
  rateLimitLogin,
  rateLimitForgotPassword,
  rateLimitRegister,
} = require('../../middleware/rateLimit.middleware');

const router = Router();

// POST /api/v1/auth/register
router.post('/register', rateLimitRegister, validarRegistro, validate, controller.register);

// POST /api/v1/auth/login
router.post('/login', rateLimitLogin, validarLogin, validate, controller.login);

// POST /api/v1/auth/logout  (requiere autenticación)
router.post('/logout', authenticate, validarLogout, validate, controller.logout);

// POST /api/v1/auth/refresh
router.post('/refresh', validarRefreshToken, validate, controller.refresh);

// POST /api/v1/auth/forgot-password
router.post('/forgot-password', rateLimitForgotPassword, validarForgotPassword, validate, controller.forgotPassword);

// POST /api/v1/auth/reset-password
router.post('/reset-password', validarResetPassword, validate, controller.resetPassword);

// POST /api/v1/auth/verify-email
router.post('/verify-email', validarVerifyEmail, validate, controller.verifyEmail);

module.exports = router;
