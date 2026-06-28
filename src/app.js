const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { FRONTEND_URL, NODE_ENV } = require('./config/env');
const { rateLimitGeneral } = require('./middleware/rateLimit.middleware');
const { errorHandler } = require('./middleware/error.middleware');
const logger = require('./utils/logger');

// Importar rutas
const authRoutes     = require('./modules/auth/auth.routes');
const userRoutes     = require('./modules/users/user.routes');
const businessRoutes = require('./modules/businesses/business.routes');
const leadRoutes     = require('./modules/leads/lead.routes');
const pipelineRoutes = require('./modules/pipeline/pipeline.routes');
const importRoutes   = require('./modules/imports/import.routes');
const aiRoutes       = require('./modules/ai/ai.routes');
const webhookRoutes      = require('./modules/webhooks/webhook.routes');
const automationRoutes   = require('./modules/automations/automation.routes');
const subscriptionRoutes = require('./modules/subscriptions/subscription.routes');
const adminRoutes        = require('./modules/admin/admin.routes');

const app = express();

// Railway / proxies reversos — necesario para que req.ip y rate-limit usen la IP real
app.set('trust proxy', 1);

// ─── SEGURIDAD: HEADERS HTTP ──────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, callback) => {
      // Permitir requests sin origin (Postman, apps móviles)
      if (!origin) return callback(null, true);

      const origenesPermitidos = [
        FRONTEND_URL,
        'http://localhost:5173',
        'http://localhost:3000',
        'https://hoppscotch.io',
      ];

      if (origenesPermitidos.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: Origen no permitido → ${origin}`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

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
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'CREA OS API funcionando',
    env: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ─── RUTAS DE LA API ──────────────────────────────────────────────────────────
app.use('/api/v1/auth',      authRoutes);
app.use('/api/v1/users',     userRoutes);
app.use('/api/v1/businesses', businessRoutes);
app.use('/api/v1/leads',              leadRoutes);
app.use('/api/v1/pipeline',           pipelineRoutes);
app.use('/api/v1/imports',            importRoutes);
app.use('/api/v1/ai/conversations',   aiRoutes);
app.use('/api/v1/webhooks',           webhookRoutes);
app.use('/api/v1/automations',        automationRoutes);
app.use('/api/v1/subscriptions',      subscriptionRoutes);
app.use('/api/v1/admin',              adminRoutes);

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
