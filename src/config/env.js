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

  // Email
  EMAIL_HOST: process.env.EMAIL_HOST,
  EMAIL_PORT: parseInt(process.env.EMAIL_PORT, 10) || 587,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
  EMAIL_FROM: process.env.EMAIL_FROM || 'CREA OS <noreply@creaos.com>',

  // Frontend
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

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
};
