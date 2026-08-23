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

  // Fase 2.0 (blueprint Meta+Gupshup Embedded Signup) — clave maestra para
  // cifrar credenciales de WhatsAppChannel por tenant (ver
  // channels/channelCrypto.js). NUNCA se usa directo para cifrar: cada
  // canal deriva su propia subclave vía HKDF a partir de esta — así, si
  // algo más acotado que esta variable se filtra (una subclave derivada
  // en un log, un dump puntual), el daño queda contenido a un canal, no a
  // los 100 tenants. 32 bytes en hex (64 caracteres) — generar con
  // `openssl rand -hex 32`.
  CHANNEL_CREDENTIALS_KEY: process.env.CHANNEL_CREDENTIALS_KEY,

  // Cloudinary (logo, fotos de producto, PDF informativo)
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,

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
  // Modelo "barato" para el model routing de ai.service.js#generateReply()
  // (PR39 del blueprint de Fase 2) — deliberadamente una env var y NO una
  // constante en el código: el objetivo es poder migrar a otro modelo/tier
  // más barato (ej. una futura generación tipo "GPT-5.6 Terra") con un
  // cambio de variable en Railway, sin tocar código ni redeployar, el día
  // que gpt-4o-mini deje de ser la opción vigente. Mismo motivo por el que
  // OPENAI_MODEL (arriba) ya es una env var y no algo hardcodeado.
  OPENAI_MODEL_CHEAP: process.env.OPENAI_MODEL_CHEAP || 'gpt-4o-mini',
  // Apagado por default a propósito: con este flag en false,
  // generateReply() usa OPENAI_MODEL para absolutamente todo, byte a byte
  // igual que antes de PR39 — el ahorro de costo de model routing viene
  // con un trade-off real de calidad de respuesta (ver PR body de PR39),
  // así que activarlo es una decisión de negocio explícita, no algo que
  // este PR deba imponer solo por mergearse. Mismo patrón que
  // WHATSAPP_QUEUE_PROCESSING_ENABLED (abajo).
  AI_MODEL_ROUTING_ENABLED: process.env.AI_MODEL_ROUTING_ENABLED === 'true',

  // Meta Ads
  META_APP_ID:              process.env.META_APP_ID,
  META_APP_SECRET:          process.env.META_APP_SECRET,
  META_GRAPH_API_VERSION:   process.env.META_GRAPH_API_VERSION || 'v19.0',

  // TikTok Ads
  TIKTOK_APP_SECRET: process.env.TIKTOK_APP_SECRET,

  // Stripe
  STRIPE_SECRET_KEY:     process.env.STRIPE_SECRET_KEY,
  STRIPE_PUBLIC_KEY:     process.env.STRIPE_PUBLIC_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,

  // Mercado Pago
  MP_ACCESS_TOKEN:    process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY:      process.env.MP_PUBLIC_KEY,
  MP_WEBHOOK_SECRET:  process.env.MP_WEBHOOK_SECRET,

  // App
  APP_URL: process.env.APP_URL || 'http://localhost:3001',

  // Firebase Admin SDK (FCM — push.service.js#sendToUser(), PR-B del plan de
  // empaquetado Android). Valores del service account JSON descargado de
  // Firebase Console → Project Settings → Service Accounts → Generate new
  // private key — NUNCA el archivo completo commiteado, solo estas 3
  // variables. FIREBASE_PRIVATE_KEY llega desde Railway como una sola línea
  // con "\n" literales (no saltos de línea reales); se des-escapa recién acá,
  // una sola vez, para que quien importe FIREBASE_PRIVATE_KEY de este archivo
  // ya reciba el PEM real, sin repetir el .replace() en cada consumidor.
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || '',
  FIREBASE_PRIVATE_KEY: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // WhatsApp Business API (Meta)
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || '',
  WHATSAPP_TOKEN:        process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_ID:     process.env.WHATSAPP_PHONE_ID || '',
  // App secret de la Meta App bajo la que está registrado el número de WhatsApp (para x-hub-signature-256).
  // Si el WhatsApp Business Account vive en la misma Meta App que Facebook Lead Ads, puede quedar vacío y se usa META_APP_SECRET.
  WHATSAPP_APP_SECRET:   process.env.WHATSAPP_APP_SECRET || '',

  // Gupshup (WhatsApp)
  GUPSHUP_API_KEY:      process.env.GUPSHUP_API_KEY || '',
  GUPSHUP_APP_NAME:     process.env.GUPSHUP_APP_NAME || '',
  GUPSHUP_PHONE_NUMBER: process.env.GUPSHUP_PHONE_NUMBER || '',
  GUPSHUP_WABA_ID:      process.env.GUPSHUP_WABA_ID || '',
  // GUID de la app en el dashboard de Gupshup (distinto de GUPSHUP_APP_NAME,
  // que es el nombre legible) — lo requiere la API de plantillas (listar y
  // enviar), que a diferencia de sendWhatsAppMessage() sí es por-app, no por
  // el número compartido (ventana de 24h / WhatsApp Business templates).
  GUPSHUP_APP_ID:       process.env.GUPSHUP_APP_ID || '',
  // Valor secreto configurado en el panel de Gupshup (Webhook → Custom Header) bajo el nombre
  // X-Gupshup-Webhook-Token — Gupshup no ofrece Basic Auth, solo un header personalizado libre.
  GUPSHUP_WEBHOOK_HEADER: process.env.GUPSHUP_WEBHOOK_HEADER || 'x-gupshup-webhook-token', GUPSHUP_WEBHOOK_TOKEN: process.env.GUPSHUP_WEBHOOK_TOKEN || '',

  // Feature flag temporal (Implementation Blueprint, Decisión 3) — corte del
  // webhook de Gupshup hacia el nuevo Inbound Gateway (sub-fase 1.c en
  // adelante). Default OFF: si la variable no existe (estado actual en
  // Railway), el flujo viejo (findGupshupConfig/processGupshupMessage)
  // sigue siendo el único que corre. Se elimina junto con el código viejo
  // en la sub-fase 1.f, tras la ventana de validación de 14 días (1.e).
  WHATSAPP_CHANNEL_CORE_ENABLED: process.env.WHATSAPP_CHANNEL_CORE_ENABLED === 'true',

  // Segundo flag, independiente del anterior (sub-fase 1.d). Con
  // WHATSAPP_CHANNEL_CORE_ENABLED=true y este en false (default), el Inbound
  // Gateway sigue llamando processGupshupMessage() directo, síncrono — el
  // mismo comportamiento ya validado en la sub-fase 1.c (Etapa C). Solo con
  // AMBOS flags en true el mensaje pasa por BullMQ/worker. Separarlo del
  // flag de Channel Core permite un rollback de un solo paso (apagar este)
  // sin perder la validación de 1.c.
  WHATSAPP_QUEUE_PROCESSING_ENABLED: process.env.WHATSAPP_QUEUE_PROCESSING_ENABLED === 'true',
};
