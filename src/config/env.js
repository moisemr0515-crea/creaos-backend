require('dotenv').config();

// Variables obligatorias para arrancar el servidor
const REQUIRED_VARS = [
  'MONGODB_URI',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
];

/**
 * Lanza un error si faltan variables de entorno críticas.
 * Se llama antes de iniciar el servidor.
 */
const validateEnv = () => {
  const faltantes = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (faltantes.length > 0) {
    throw new Error(
      `❌ Variables de entorno faltantes: ${faltantes.join(', ')}\n` +
        '   Copia .env.example a .env y completa los valores.'
    );
  }
};

module.exports = {
  validateEnv,

  // Servidor
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Base de datos
  MONGODB_URI: process.env.MONGODB_URI,

  // Redis
  REDIS_URL: process.env.REDIS_URL,

  // JWT
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // Email (Resend — API HTTPS, evita el bloqueo de SMTP saliente de Railway)
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM || 'CREA OS <noreply@creaos.com>',

  // Frontend
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

  // CORS — lista de orígenes permitidos separados por coma
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origen) => origen.trim())
    .filter(Boolean),

  // Seguridad
  BCRYPT_SALT_ROUNDS: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12,

  // OpenAI
  OPENAI_API_KEY:  process.env.OPENAI_API_KEY,
  OPENAI_MODEL:    process.env.OPENAI_MODEL || 'gpt-4o',
  AI_MAX_TOKENS:   parseInt(process.env.AI_MAX_TOKENS, 10) || 1000,
  AI_TEMPERATURE:  parseFloat(process.env.AI_TEMPERATURE) || 0.7,

  // Meta Ads
  META_APP_SECRET:          process.env.META_APP_SECRET,
  META_GRAPH_API_VERSION:   process.env.META_GRAPH_API_VERSION || 'v19.0',

  // TikTok Ads
  TIKTOK_APP_SECRET: process.env.TIKTOK_APP_SECRET,

  // Stripe
  STRIPE_SECRET_KEY:     process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLIC_KEY:     process.env.STRIPE_PUBLIC_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,

  // Mercado Pago
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY:   process.env.MP_PUBLIC_KEY,

  // App
  APP_URL: process.env.APP_URL || 'http://localhost:3001',

  // WhatsApp Business API (Meta)
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || '',
  WHATSAPP_TOKEN:        process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_ID:     process.env.WHATSAPP_PHONE_ID || '',

  // Gupshup (WhatsApp)
  GUPSHUP_API_KEY:      process.env.GUPSHUP_API_KEY || '',
  GUPSHUP_APP_NAME:     process.env.GUPSHUP_APP_NAME || '',
  GUPSHUP_PHONE_NUMBER: process.env.GUPSHUP_PHONE_NUMBER || '',
  GUPSHUP_WABA_ID:      process.env.GUPSHUP_WABA_ID || '',
};
