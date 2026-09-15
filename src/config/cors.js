const { FRONTEND_URL, ALLOWED_ORIGINS, CAPACITOR_ORIGINS, NODE_ENV } = require('./env');

const normalizeOrigin = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const configuredOrigins = new Set(
  [FRONTEND_URL, ...ALLOWED_ORIGINS, ...CAPACITOR_ORIGINS]
    .map(normalizeOrigin)
    .filter(Boolean)
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (normalized !== origin.replace(/\/$/, '')) return false;

  if (NODE_ENV !== 'production') {
    const { hostname } = new URL(normalized);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  }

  return configuredOrigins.has(normalized);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS: Origen no permitido → ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

module.exports = { normalizeOrigin, isAllowedOrigin, corsOptions };
