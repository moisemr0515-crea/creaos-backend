const nodemailer = require('nodemailer');
const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM, FRONTEND_URL } = require('../config/env');
const logger = require('./logger');

// Crear transporter reutilizable
const crearTransporter = () => {
  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465, // SSL en puerto 465, STARTTLS en 587
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
};

/**
 * Envía un email genérico.
 * En desarrollo, loguea el email sin enviarlo si no hay configuración SMTP.
 */
const enviarEmail = async ({ to, subject, html }) => {
  // Si no hay configuración SMTP, solo loguear (útil en desarrollo)
  if (!EMAIL_HOST || !EMAIL_USER) {
    logger.warn(`[EMAIL - modo dev] Para: ${to} | Asunto: ${subject}`);
    return;
  }

  try {
    const transporter = crearTransporter();
    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      html,
    });
    logger.info(`Email enviado: ${info.messageId} → ${to}`);
  } catch (error) {
    // TODO: revertir a solo error.message una vez resuelto el fallo de envío en producción
    logger.error(`Error enviando email a ${to}: ${error.message}`, {
      code: error.code,
      responseCode: error.responseCode,
      response: error.response,
      command: error.command,
      stack: error.stack,
    });
    // No lanzar el error para no bloquear el flujo principal
  }
};

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

/**
 * Email de verificación de cuenta.
 */
const enviarEmailVerificacion = async ({ email, nombre, token }) => {
  const url = `${FRONTEND_URL}/auth/verify-email?token=${token}`;

  await enviarEmail({
    to: email,
    subject: '✅ Verifica tu cuenta en CREA OS',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">¡Bienvenido a CREA OS, ${nombre}!</h2>
        <p>Gracias por registrarte. Para activar tu cuenta, haz clic en el botón:</p>
        <a href="${url}"
           style="display:inline-block; padding:12px 24px; background:#4F46E5; color:white; text-decoration:none; border-radius:6px;">
          Verificar mi cuenta
        </a>
        <p style="margin-top:20px; color:#666;">
          Este enlace expira en <strong>24 horas</strong>.<br>
          Si no creaste esta cuenta, ignora este email.
        </p>
        <hr style="margin-top:30px; border:none; border-top:1px solid #eee;">
        <p style="color:#999; font-size:12px;">CREA OS — Agente de ventas con IA</p>
      </div>
    `,
  });
};

/**
 * Email de recuperación de contraseña.
 */
const enviarEmailResetPassword = async ({ email, nombre, token }) => {
  const url = `${FRONTEND_URL}/auth/reset-password?token=${token}`;

  await enviarEmail({
    to: email,
    subject: '🔑 Recupera tu contraseña en CREA OS',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">Recuperar contraseña</h2>
        <p>Hola ${nombre}, recibimos una solicitud para restablecer tu contraseña.</p>
        <a href="${url}"
           style="display:inline-block; padding:12px 24px; background:#4F46E5; color:white; text-decoration:none; border-radius:6px;">
          Restablecer contraseña
        </a>
        <p style="margin-top:20px; color:#666;">
          Este enlace expira en <strong>1 hora</strong>.<br>
          Si no solicitaste esto, ignora este email. Tu contraseña no cambiará.
        </p>
        <hr style="margin-top:30px; border:none; border-top:1px solid #eee;">
        <p style="color:#999; font-size:12px;">CREA OS — Agente de ventas con IA</p>
      </div>
    `,
  });
};

module.exports = { enviarEmail, enviarEmailVerificacion, enviarEmailResetPassword };
