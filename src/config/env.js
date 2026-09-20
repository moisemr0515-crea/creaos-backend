require('dotenv').config();

const REQUIRED_BY_RUNTIME = {
  api: [
    'NODE_ENV',
    'MONGODB_URI',
    'REDIS_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'FRONTEND_URL',
    'OPENAI_API_KEY',
    'RESEND_API_KEY',
  ],
  worker: ['NODE_ENV', 'MONGODB_URI', 'REDIS_URL', 'OPENAI_API_KEY'],
};

/**
 * Lanza un error si faltan variables de entorno críticas.
 * Se llama antes de iniciar el servidor.
 */
const hasValue = (name) => typeof process.env[name] === 'string' && process.env[name].trim().length > 0;

const requireCompleteGroup = (missing, variables) => {
  if (!variables.some(hasValue)) return;
  variables.filter((name) => !hasValue(name)).forEach((name) => missing.push(name));
};

const requireIfEnabled = (missing, evidence, required) => {
  if (!evidence.some(hasValue)) return;
  required.filter((name) => !hasValue(name)).forEach((name) => missing.push(name));
};

const validateProductionWebhookEnv = () => {
  if (process.env.NODE_ENV !== 'production') return;

  const missing = [];
  const requireIfConfigured = (evidenceVars, requiredVars) => {
    if (!evidenceVars.some(hasValue)) return;
    for (const required of requiredVars) {
      if (Array.isArray(required)) {
        if (!required.some(hasValue)) missing.push(required.join(' o '));
      } else if (!hasValue(required)) {
        missing.push(required);
      }
    }
  };

  // Una integración sin ninguna credencial funcional se considera
  // deshabilitada. Si hay señales de que está configurada, su secreto de
  // verificación pasa a ser obligatorio antes de aceptar tráfico.
  requireIfConfigured(['META_APP_ID'], ['META_APP_SECRET']);
  requireIfConfigured(['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'], [['WHATSAPP_APP_SECRET', 'META_APP_SECRET']]);
  requireIfConfigured(
    ['GUPSHUP_API_KEY', 'GUPSHUP_APP_NAME', 'GUPSHUP_PHONE_NUMBER'],
    ['GUPSHUP_WEBHOOK_TOKEN']
  );
  requireIfConfigured(
    ['GUPSHUP_PARTNER_EMAIL', 'GUPSHUP_PARTNER_SECRET', 'META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'],
    ['GUPSHUP_ONBOARDING_WEBHOOK_TOKEN']
  );
  requireIfConfigured(['STRIPE_SECRET_KEY', 'STRIPE_PUBLIC_KEY'], ['STRIPE_WEBHOOK_SECRET']);
  requireIfConfigured(['MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY'], ['MP_WEBHOOK_SECRET']);

  if (missing.length > 0) {
    throw new Error(`❌ Secretos de webhook faltantes para integraciones configuradas: ${[...new Set(missing)].join(', ')}`);
  }
};

const validateProductionIntegrations = ({ runtime }) => {
  if (process.env.NODE_ENV !== 'production') return;
  const missing = [];

  requireCompleteGroup(missing, ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);
  requireCompleteGroup(missing, ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']);

  if (runtime === 'api') {
    requireCompleteGroup(missing, ['STRIPE_SECRET_KEY', 'STRIPE_PUBLIC_KEY', 'STRIPE_WEBHOOK_SECRET']);
    requireCompleteGroup(missing, ['MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY', 'MP_WEBHOOK_SECRET']);
    requireCompleteGroup(missing, ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID']);
    requireCompleteGroup(missing, ['GUPSHUP_API_KEY', 'GUPSHUP_APP_NAME', 'GUPSHUP_PHONE_NUMBER']);
    requireIfEnabled(
      missing,
      ['GUPSHUP_PARTNER_EMAIL', 'GUPSHUP_PARTNER_SECRET', 'META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'],
      [
        'GUPSHUP_PARTNER_EMAIL',
        'GUPSHUP_PARTNER_SECRET',
        'GUPSHUP_ONBOARDING_WEBHOOK_TOKEN',
        'BACKEND_PUBLIC_URL',
        'CHANNEL_CREDENTIALS_KEY',
      ]
    );
  }

  if (missing.length > 0) {
    throw new Error(`❌ Configuración parcial de integración: ${[...new Set(missing)].join(', ')}`);
  }
};

const validateProductionSecurity = ({ runtime }) => {
  if (process.env.NODE_ENV !== 'production') return;

  if (runtime === 'api') {
    if (process.env.JWT_SECRET.length < 32 || process.env.JWT_REFRESH_SECRET.length < 32) {
      throw new Error('❌ JWT_SECRET y JWT_REFRESH_SECRET deben tener al menos 32 caracteres en producción');
    }
    if (process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
      throw new Error('❌ JWT_SECRET y JWT_REFRESH_SECRET deben ser diferentes');
    }
  }

  if (hasValue('CHANNEL_CREDENTIALS_KEY') && !/^[a-f0-9]{64}$/i.test(process.env.CHANNEL_CREDENTIALS_KEY.trim())) {
    throw new Error('❌ CHANNEL_CREDENTIALS_KEY debe contener exactamente 32 bytes en hexadecimal');
  }

  const originVars = ['FRONTEND_URL', 'ALLOWED_ORIGINS', 'CAPACITOR_ORIGINS'];
  for (const name of originVars) {
    for (const value of (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean)) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`❌ ${name} contiene un origen inválido`);
      }
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, '')) {
        throw new Error(`❌ ${name} debe contener orígenes exactos, sin rutas ni patrones`);
      }
    }
  }
};

const validateEnv = ({ runtime = 'api', validateWebhookIntegrations = runtime === 'api' } = {}) => {
  if (!REQUIRED_BY_RUNTIME[runtime]) throw new Error(`Runtime desconocido: ${runtime}`);
  const faltantes = REQUIRED_BY_RUNTIME[runtime].filter((v) => !hasValue(v));
  if (faltantes.length > 0) {
    throw new Error(
      `❌ Variables de entorno faltantes: ${faltantes.join(', ')}\n` +
        '   Copia .env.example a .env y completa los valores.'
    );
  }
  validateProductionSecurity({ runtime });
  if (validateWebhookIntegrations) validateProductionWebhookEnv();
  validateProductionIntegrations({ runtime });
};

module.exports = {
  validateEnv,

  // Servidor
  PORT: parseInt(process.env.PORT, 10) || 3000,
  // Fail-safe: los entrypoints exigen NODE_ENV mediante validateEnv(). Si un
  // módulo se carga fuera de ellos, la ausencia nunca habilita excepciones de
  // desarrollo para firmas de webhooks.
  NODE_ENV: process.env.NODE_ENV || 'production',

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
  // Origen local real del WebView Android de Capacitor. Puede ampliarse con
  // valores exactos separados por coma, nunca con comodines.
  CAPACITOR_ORIGINS: (process.env.CAPACITOR_ORIGINS || 'https://localhost')
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
  // Bloque 3 de la auditoría Business Brain (§45-56, 20/sep/2026) — RAG del
  // PDF + semántica de FAQ/Policy. text-embedding-3-small (1536 dims): el
  // estándar de costo/calidad de OpenAI para retrieval, sin evidencia
  // todavía de que este dominio (documentos de venta en español) necesite
  // el modelo "large" — mismo criterio de "no sofisticar sin evidencia" que
  // el resto del proyecto.
  OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
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

  // Meta WhatsApp Embedded Signup (Fase 2.1, blueprint maestro §19) — config
  // ID que se crea en el dashboard de la app de Meta específicamente para el
  // flujo de Embedded Signup (distinto de META_APP_ID, que ya existe arriba
  // para otros usos de Meta). Sin default: probablemente no existe todavía
  // en Railway/local — channel.controller.js#initEmbeddedSignup() lo maneja
  // como null sin romper la creación de la sesión, ver comentario ahí.
  META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID || '',

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

  // Bundles OTA de la app Android (capacitor-updater) — en Railway esto
  // debe apuntar al mount path de un Volume persistente (ver
  // appUpdate.service.js): el filesystem normal de un servicio de Railway
  // se pierde en cada redeploy. Default solo para dev local, donde no hace
  // falta persistencia real entre reinicios.
  APP_UPDATES_DIR: process.env.APP_UPDATES_DIR || './data/app-updates',

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

  // Gupshup Partner API (control plane — onboarding de tenants nuevos vía
  // Embedded Signup, distinto del apikey de mensajería de arriba). Credenciales
  // de servidor del Partner Portal (email + client secret), NO por-tenant.
  // Sin default: si faltan, partner.auth.js#getValidToken() falla ruidoso
  // recién cuando algo intenta loguear, no bloquea el arranque del servidor
  // (la mensajería existente no depende de esto).
  GUPSHUP_PARTNER_EMAIL:  process.env.GUPSHUP_PARTNER_EMAIL || '',
  GUPSHUP_PARTNER_SECRET: process.env.GUPSHUP_PARTNER_SECRET || '',

  // Incidente del 04/sep/2026 (docs/implementation/known-issues.md, Bug 3):
  // secreto PROPIO y SEPARADO de GUPSHUP_WEBHOOK_TOKEN (arriba), exclusivo
  // de la ruta nueva /api/v1/webhooks/gupshup/onboarding/:appId
  // (channelOnboardingWebhook.controller.js). A propósito NO se reutiliza
  // GUPSHUP_WEBHOOK_TOKEN: ese es el que ya protege /api/v1/webhooks/gupshup,
  // el endpoint con tráfico real de producción hoy (canal PLATFORM) — no se
  // toca su alcance ni su comportamiento. Se manda a Gupshup vía el campo
  // `meta` de partner.subscriptions.js#subscribeToEvents() (header custom
  // `x-gupshup-webhook-secret`, mecanismo documentado por Gupshup mismo para
  // este endpoint), Gupshup lo reenvía en cada request a esta URL — incluye,
  // según todo lo investigado, el ping de verificación al crear la
  // suscripción, no solo los eventos reales.
  GUPSHUP_ONBOARDING_WEBHOOK_TOKEN: process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN || '',

  // PR1 (docs/implementation/known-issues.md, 07/sep/2026): allowlist de
  // rollout progresivo para el outbound vía Partner API — SUPERADO por PR2
  // (WhatsAppChannel.outboundApi, por canal). Ya NO lo lee
  // gupshupProvider.js#resolveOutboundMode() — se mantiene declarada
  // únicamente como mecanismo TEMPORAL de transición mientras se confirma
  // que PR2 quedó estable en producción; retirarla de Railway después no
  // requiere ningún cambio de código (nadie la consulta).
  GUPSHUP_PARTNER_OUTBOUND_APP_IDS: (process.env.GUPSHUP_PARTNER_OUTBOUND_APP_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // PR2 (docs/implementation/known-issues.md, 07/sep/2026): kill switch de
  // EMERGENCIA global — fuerza Legacy para TODOS los canales sin importar
  // su outboundApi individual, sin importar connectionType. Uso previsto:
  // un incidente amplio de la Partner API de Gupshup, NO el mecanismo
  // normal de routing (eso es outboundApi, por canal) — ver
  // gupshupProvider.js#resolveOutboundMode(), primer chequeo de la función.
  // Default false/apagado: no cambia nada del comportamiento normal.
  GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH: process.env.GUPSHUP_PARTNER_OUTBOUND_KILL_SWITCH === 'true',

  // URL pública de ESTE backend (no la del frontend — eso es APP_URL/FRONTEND_URL
  // arriba). BACKEND_PUBLIC_URL + '/api/v1/webhooks/gupshup/onboarding/{appId}'
  // (channelOnboardingWebhook.controller.js) es la URL que se manda al
  // suscribirse a eventos ACCOUNT de una app de Gupshup (ver
  // channel.controller.js#completeGupshupEmbeddedSignup() y
  // partner.subscriptions.js) — DISTINTA de '/api/v1/webhooks/gupshup' a
  // secas (esa sigue siendo solo para el canal PLATFORM, sin cambios, ver
  // GUPSHUP_ONBOARDING_WEBHOOK_TOKEN arriba). Sin default: si falta, ese paso
  // puntual falla ruidoso (AppError 500) en vez de suscribir un callback
  // vacío/inválido.
  BACKEND_PUBLIC_URL: process.env.BACKEND_PUBLIC_URL || '',

  // Sub-fase 1.d. El Inbound Gateway (único camino desde la Fase 1.f, ver
  // known-issues.md) llama a processGupshupMessage() directo y síncrono
  // mientras este flag esté en false (default) — mismo comportamiento ya
  // validado en la sub-fase 1.c. Solo con este flag en true el mensaje pasa
  // por BullMQ/worker en su lugar.
  WHATSAPP_QUEUE_PROCESSING_ENABLED: process.env.WHATSAPP_QUEUE_PROCESSING_ENABLED === 'true',

  // Caso 7 del backlog (motor de automatizaciones, trigger por tiempo) —
  // automationSweep.worker.js. Ambas con default: no son obligatorias, y un
  // valor inválido/ausente no debe impedir que el worker arranque.
  //
  // Cada cuánto corre el barrido que reevalúa leads contra los triggers de
  // tiempo (lead_stale/stage_stalled). 15 minutos por default — la
  // condición es "N días", no hace falta más resolución que eso.
  AUTOMATION_SWEEP_INTERVAL_MS: parseInt(process.env.AUTOMATION_SWEEP_INTERVAL_MS, 10) || 15 * 60 * 1000,
  // Ventana mínima entre dos ejecuciones de la MISMA automatización sobre
  // el MISMO lead — sin esto, un lead que sigue cumpliendo la condición se
  // re-encolaría en cada ciclo del barrido. 24h por default.
  AUTOMATION_COOLDOWN_HOURS: parseInt(process.env.AUTOMATION_COOLDOWN_HOURS, 10) || 24,
};
