const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

/**
 * Clave de `rateLimitGeneral` — por usuario autenticado cuando se puede
 * identificar uno, con IP como fallback para tráfico anónimo.
 *
 * Incidente real de producción (06/sep/2026, docs/implementation/known-issues.md):
 * `rateLimitGeneral` corre en app.js ANTES de montar cualquier ruta —
 * `authenticate` (el middleware que popula req.user) se aplica por ruta
 * individual, nunca corrió todavía en este punto. Detrás de Railway
 * (trust proxy, ver nota en app.js), req.ip resuelve sistemáticamente a un
 * puñado de IPs internas COMPARTIDAS por usuarios sin relación entre sí —
 * mismo hallazgo que ya motivó cambiar rateLimitLogin de IP a email (ver
 * ese comentario más abajo), nunca aplicado acá. Confirmado en vivo:
 * exactamente 100 requests (el máximo) en 3m24s desde una sola IP,
 * repartidos entre 3 cuentas de usuario DISTINTAS — tráfico normal de
 * dashboard, no abuso — bastaba para que un cuarto usuario detrás de esa
 * misma IP (incluido un login legítimo, sin sesión previa) chocara con
 * "Demasiadas solicitudes" sin haber hecho nada mal.
 *
 * Decodifica el JWT del header Authorization DIRECTO acá (sin invocar
 * authenticate() completo — sin lookup a Mongo, sin popular req.user) solo
 * para extraer `sub` (userId) y usarlo de clave. La firma SÍ se valida
 * (jwt.verify(), no jwt.decode()) — no se puede falsificar el `sub` de otro
 * usuario con un token no firmado o firmado con otra clave, eso lo rechaza
 * igual.
 *
 * `ignoreExpiration: true` a propósito: un access token vencido (normal,
 * TTL de 15min — JWT_EXPIRES_IN) sigue identificando de forma confiable AL
 * MISMO usuario para efectos de CONTEO — no se usa acá para autorizar nada
 * (authenticate() más abajo en la ruta real sigue exigiendo un token
 * vigente, sin cambios). Ignorar el vencimiento solo acá evita perder la
 * identidad del caller justo en la ventana de expiración/refresh — que es
 * exactamente el momento de más tráfico de reintento, y el que disparó el
 * incidente real.
 *
 * Cualquier otro caso (sin header, formato inválido, firma que no valida,
 * token de otro secreto) cae a IP — mismo comportamiento que hoy, sin
 * cambios para tráfico realmente anónimo (login antes de tener sesión,
 * webhooks de Gupshup/Meta/TikTok con sus propios esquemas de auth, etc.).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function claveRateLimitGeneral(req) {
  const header = req.headers?.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return req.ip;

  try {
    const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    return payload.sub ? `user:${payload.sub}` : req.ip;
  } catch {
    return req.ip;
  }
}

/**
 * Rate limit global para todas las rutas de la API.
 * 100 requests por 15 minutos — por usuario autenticado si se puede
 * identificar uno (ver claveRateLimitGeneral()), por IP si no.
 */
const rateLimitGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: claveRateLimitGeneral,
  message: {
    success: false,
    message: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.',
  },
});

/**
 * Rate limit estricto para login.
 * 5 intentos por CUENTA (email intentado) cada 15 minutos.
 * Bloquea ataques de fuerza bruta.
 *
 * Por email, NO por IP — hallazgo real de producción (no hipotético):
 * detrás de Railway, req.ip resolvía sistemáticamente a un puñado de IPs
 * internas de Railway compartidas por TODO el tráfico real (ver nota en
 * app.js sobre trust proxy) — el balde de "5 intentos" terminaba
 * compartido entre usuarios distintos sin relación entre sí, así que
 * bastaban unos pocos intentos legítimos combinados (de gente distinta)
 * para bloquear a todo el mundo, sin que nadie individualmente hubiera
 * fallado el login varias veces.
 *
 * Con la clave por email, el límite protege lo que realmente importa
 * (fuerza bruta contra UNA cuenta puntual) y deja de depender de que
 * Railway resuelva la IP real correctamente — algo que su propio soporte
 * confirma que no está garantizado de forma estable entre requests.
 *
 * Trade-off conocido y aceptado: alguien que sepa el email de otra
 * persona puede "trabarle" el login por 15 min fallando 5 veces a
 * propósito (denegación de servicio dirigida a una cuenta). Para este
 * CRM interno, con usuarios conocidos y sin ser un objetivo de alto
 * valor, se considera un riesgo aceptable frente al problema real que
 * esto soluciona. Si se vuelve un problema, la mitigación estándar es
 * backoff progresivo en vez de bloqueo duro, no volver a IP.
 */
const rateLimitLogin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // No contar logins exitosos
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    // Sin email (body malformado/vacío — rateLimitLogin corre ANTES que
    // validarLogin en la ruta, ver auth.routes.js) cae a IP, mismo criterio
    // de antes — ese caso de todas formas lo rechaza el validator después.
    return email || req.ip;
  },
  message: {
    success: false,
    message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.',
  },
});

/**
 * Rate limit para forgot-password.
 * 3 solicitudes por IP cada hora (previene spam de emails).
 */
const rateLimitForgotPassword = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiadas solicitudes de recuperación. Intenta de nuevo en 1 hora.',
  },
});

/**
 * Rate limit para registro.
 * 5 registros por IP cada hora.
 */
const rateLimitRegister = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Demasiados registros desde esta IP. Intenta de nuevo en 1 hora.',
  },
});

/**
 * Rate limit para POST /missions/regenerate (llama a GPT-4o, cuesta dinero).
 * 5 regeneraciones por NEGOCIO cada hora — a diferencia de los limiters de
 * arriba (por IP), este se scopea por `req.businessId` porque el objetivo es
 * evitar abuso de la API de OpenAI por negocio, sin importar cuántos
 * usuarios distintos del mismo negocio lo disparen. Requiere que
 * `authenticate` + `injectTenant` ya hayan corrido antes (para tener
 * req.businessId disponible), igual que los demás middlewares de esta ruta.
 */
const rateLimitMissionRegenerate = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.businessId?.toString() || req.ip,
  message: {
    success: false,
    message: 'Demasiadas regeneraciones de Misión del Día. Intenta de nuevo más tarde (máximo 5 por hora).',
  },
});

module.exports = {
  rateLimitGeneral,
  rateLimitLogin,
  rateLimitForgotPassword,
  rateLimitRegister,
  rateLimitMissionRegenerate,
  // Exportada aparte para poder testear la lógica de la clave sin tener que
  // simular 100 requests reales contra el rate limiter completo.
  claveRateLimitGeneral,
};
