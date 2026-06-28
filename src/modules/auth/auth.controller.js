const authService = require('./auth.service');
const { respuestaExito } = require('../../utils/response');

/**
 * POST /api/v1/auth/register
 * Crea usuario + negocio, asigna rol Owner, envía email de verificación.
 */
const register = async (req, res, next) => {
  try {
    const { name, email, password, businessName, phone } = req.body;

    const resultado = await authService.registrar({ name, email, password, businessName, phone });

    return respuestaExito(res, {
      statusCode: 201,
      message: 'Registro exitoso. Revisa tu email para verificar tu cuenta.',
      data: resultado,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/login
 * Autentica credenciales y devuelve accessToken + refreshToken.
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const resultado = await authService.login({ email, password });

    return respuestaExito(res, {
      statusCode: 200,
      message: 'Inicio de sesión exitoso',
      data: resultado,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/logout
 * Invalida el refresh token en Redis.
 * Requiere Bearer token válido.
 */
const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    await authService.logout({ refreshToken });

    return respuestaExito(res, {
      statusCode: 200,
      message: 'Sesión cerrada exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/refresh
 * Genera nuevo accessToken a partir de un refreshToken válido.
 */
const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    const resultado = await authService.refreshAccessToken({ refreshToken });

    return respuestaExito(res, {
      statusCode: 200,
      message: 'Token renovado exitosamente',
      data: resultado,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/forgot-password
 * Envía email con link de recuperación.
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    await authService.forgotPassword({ email });

    // Siempre 200 para no revelar si el email existe
    return respuestaExito(res, {
      statusCode: 200,
      message: 'Si el email existe, recibirás un enlace de recuperación.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/reset-password
 * Restablece la contraseña usando el token del email.
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    await authService.resetPassword({ token, password });

    return respuestaExito(res, {
      statusCode: 200,
      message: 'Contraseña actualizada exitosamente. Inicia sesión con tu nueva contraseña.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/auth/verify-email
 * Confirma la cuenta del usuario.
 */
const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.body;

    await authService.verifyEmail({ token });

    return respuestaExito(res, {
      statusCode: 200,
      message: 'Email verificado exitosamente. Ya puedes iniciar sesión.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { register, login, logout, refresh, forgotPassword, resetPassword, verifyEmail };
