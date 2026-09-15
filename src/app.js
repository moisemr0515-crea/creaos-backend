const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { NODE_ENV } = require('./config/env');
const { corsOptions } = require('./config/cors');
const { helmetOptions } = require('./config/securityHeaders');
const { checkCoreHealth } = require('./health/health.service');
const { rateLimitGeneral } = require('./middleware/rateLimit.middleware');
const { errorHandler } = require('./middleware/error.middleware');
const logger = require('./utils/logger');

// Importar rutas
const authRoutes     = require('./modules/auth/auth.routes');
const userRoutes     = require('./modules/users/user.routes');
const businessRoutes = require('./modules/businesses/business.routes');
const leadRoutes     = require('./modules/leads/lead.routes');
const pipelineRoutes = require('./modules/pipeline/pipeline.routes');
const productRoutes  = require('./modules/products/product.routes');
const policyRoutes   = require('./modules/business-knowledge/policy.routes');
const faqRoutes      = require('./modules/business-knowledge/faq.routes');
const importRoutes   = require('./modules/imports/import.routes');
const aiRoutes       = require('./modules/ai/ai.routes');
const webhookRoutes      = require('./modules/webhooks/webhook.routes');
const automationRoutes   = require('./modules/automations/automation.routes');
const subscriptionRoutes = require('./modules/subscriptions/subscription.routes');
const adminRoutes        = require('./modules/admin/admin.routes');
const whatsappRoutes     = require('./modules/whatsapp/whatsapp.routes');
const missionRoutes      = require('./modules/missions/mission.routes');
const pushRoutes         = require('./modules/push/push.routes');
const channelRoutes      = require('./modules/channels/channel.routes');

const app = express();

// Railway / proxies reversos — necesario para que req.ip y rate-limit usen la IP real.
// Investigado en vivo (soporte de Railway, station.railway.com): el número de
// saltos NO está garantizado ni documentado de forma estable — "puede haber
// otro salto según cómo se enrute la request" (respuesta oficial de Railway).
// Con `1` (el valor anterior), req.ip resolvía sistemáticamente a un puñado
// de IPs internas de Railway compartidas por TODO el tráfico real de la app
// (confirmado revisando logs de producción: el mismo handful de IPs para
// usuarios que definitivamente eran personas distintas) — cualquier lógica
// basada en IP (rate limiting, logging) terminaba agrupando usuarios
// distintos bajo la misma "IP". Se sube a `2` como mejora de mejor esfuerzo,
// pero como el número de saltos de Railway no es estable, rateLimitLogin
// específicamente ya NO depende de esto — ver keyGenerator en
// rateLimit.middleware.js.
app.set('trust proxy', 2);

// ─── SEGURIDAD: HEADERS HTTP ──────────────────────────────────────────────────
app.use(helmet(helmetOptions));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Solo orígenes exactos configurados. Los previews deben agregarse de forma
// explícita a ALLOWED_ORIGINS; un prefijo de proyecto es falsificable.
app.use(cors(corsOptions));

// ─── PARSEO DEL BODY ──────────────────────────────────────────────────────────
// Captura rawBody para verificación de firmas HMAC de webhooks (Meta, TikTok)
app.use(
  express.json({
    limit: '10kb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  })
);
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── RATE LIMIT GLOBAL ────────────────────────────────────────────────────────
app.use('/api', rateLimitGeneral);

// ─── LOG DE REQUESTS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const inicio = Date.now();

  res.on('finish', () => {
    const duracion = Date.now() - inicio;
    const nivel = res.statusCode >= 400 ? 'warn' : 'info';

    logger[nivel](`${req.method} ${req.originalUrl} → ${res.statusCode} [${duracion}ms]`, {
      ip: req.ip,
      userId: req.user?._id,
    });
  });

  next();
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health/live', (_req, res) => {
  res.status(200).json({ success: true, status: 'ok' });
});

const readinessHandler = async (_req, res) => {
  const health = await checkCoreHealth();
  res.status(health.ok ? 200 : 503).json({
    success: health.ok,
    status: health.ok ? 'ok' : 'degraded',
    dependencies: health.dependencies,
    env: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
};

app.get('/health', readinessHandler);
app.get('/health/ready', readinessHandler);

// ─── RUTAS DE LA API ──────────────────────────────────────────────────────────
app.use('/api/v1/auth',      authRoutes);
app.use('/api/v1/users',     userRoutes);
app.use('/api/v1/businesses', businessRoutes);
app.use('/api/v1/leads',              leadRoutes);
app.use('/api/v1/pipeline',           pipelineRoutes);
app.use('/api/v1/products',           productRoutes);
app.use('/api/v1/policies',           policyRoutes);
app.use('/api/v1/faqs',               faqRoutes);
app.use('/api/v1/imports',            importRoutes);
app.use('/api/v1/ai/conversations',   aiRoutes);
app.use('/api/v1/webhooks',           webhookRoutes);
app.use('/api/v1/automations',        automationRoutes);
app.use('/api/v1/subscriptions',      subscriptionRoutes);
app.use('/api/v1/admin',              adminRoutes);
app.use('/api/v1/whatsapp',           whatsappRoutes);
app.use('/api/v1/missions',           missionRoutes);
app.use('/api/v1/push',               pushRoutes);
app.use('/api/v1/channels',           channelRoutes);

// ─── RUTA NO ENCONTRADA ───────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
});

// ─── MANEJADOR GLOBAL DE ERRORES ─────────────────────────────────────────────
// Debe ser el último middleware
app.use(errorHandler);

module.exports = app;
