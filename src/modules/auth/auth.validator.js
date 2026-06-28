const { body } = require('express-validator');

// ─── REGISTER ────────────────────────────────────────────────────────────────
const validarRegistro = [
  body('name')
    .trim()
    .notEmpty().withMessage('El nombre es requerido')
    .isLength({ min: 2, max: 80 }).withMessage('El nombre debe tener entre 2 y 80 caracteres'),

  body('email')
    .trim()
    .notEmpty().withMessage('El email es requerido')
    .isEmail().withMessage('Formato de email inválido')
    .normalizeEmail(),

  body('password')
    .notEmpty().withMessage('La contraseña es requerida')
    .isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres')
    .matches(/[A-Z]/).withMessage('Debe contener al menos una mayúscula')
    .matches(/[0-9]/).withMessage('Debe contener al menos un número'),

  body('businessName')
    .trim()
    .notEmpty().withMessage('El nombre del negocio es requerido')
    .isLength({ min: 2, max: 100 }).withMessage('El nombre del negocio debe tener entre 2 y 100 caracteres'),

  body('phone')
    .optional()
    .trim()
    .isMobilePhone('any').withMessage('Número de teléfono inválido'),
];

// ─── LOGIN ────────────────────────────────────────────────────────────────────
const validarLogin = [
  body('email')
    .trim()
    .notEmpty().withMessage('El email es requerido')
    .isEmail().withMessage('Formato de email inválido')
    .normalizeEmail(),

  body('password')
    .notEmpty().withMessage('La contraseña es requerida'),
];

// ─── LOGOUT ──────────────────────────────────────────────────────────────────
const validarLogout = [
  body('refreshToken')
    .notEmpty().withMessage('El refreshToken es requerido'),
];

// ─── REFRESH TOKEN ───────────────────────────────────────────────────────────
const validarRefreshToken = [
  body('refreshToken')
    .notEmpty().withMessage('El refreshToken es requerido'),
];

// ─── FORGOT PASSWORD ─────────────────────────────────────────────────────────
const validarForgotPassword = [
  body('email')
    .trim()
    .notEmpty().withMessage('El email es requerido')
    .isEmail().withMessage('Formato de email inválido')
    .normalizeEmail(),
];

// ─── RESET PASSWORD ──────────────────────────────────────────────────────────
const validarResetPassword = [
  body('token')
    .notEmpty().withMessage('El token es requerido'),

  body('password')
    .notEmpty().withMessage('La contraseña es requerida')
    .isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres')
    .matches(/[A-Z]/).withMessage('Debe contener al menos una mayúscula')
    .matches(/[0-9]/).withMessage('Debe contener al menos un número'),

  body('confirmPassword')
    .notEmpty().withMessage('Confirmar contraseña es requerido')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Las contraseñas no coinciden');
      }
      return true;
    }),
];

// ─── VERIFY EMAIL ────────────────────────────────────────────────────────────
const validarVerifyEmail = [
  body('token')
    .notEmpty().withMessage('El token de verificación es requerido'),
];

module.exports = {
  validarRegistro,
  validarLogin,
  validarLogout,
  validarRefreshToken,
  validarForgotPassword,
  validarResetPassword,
  validarVerifyEmail,
};
