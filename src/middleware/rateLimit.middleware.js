const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Incidente real de producción (06/sep/2026, docs/implementation/known-issues.md):
 * investigando un bloqueo reportado, se encontró que un 429 de
 * `rateLimitGeneral` es estructuralmente INVISIBLE en los logs — corre en
 * app.js ANTES del middleware que loguea cada request (ver ese archivo), y
 * al bloquear responde directo sin llamar a `next()`, así que ese
 * middleware de logging nunca llega a ejecutarse para esa request. Sin este
 * logueo explícito, confirmar (o descartar) que un limiter fue la causa de
 * un incidente puntual requiere reconstruir todo por inferencia indirecta
 * — exactamente lo que hubo que hacer para diagnosticar el incidente que
 * motivó esto.
 *
 * `handler` reemplaza el manejo default de express-rate-limit (que solo
 * hace `res.status(...).send(message)`, sin loguear nada) — replica ESE
 * mismo comportamiento pero logueando antes vía nuestro logger real. No es
 * exclusivo de rateLimitGeneral: se reusa para rateLimitLogin también, para
 * poder distinguir en los logs cuál de los 2 disparó.
 *
 * @param {string} nombre - identifica el limiter en el log (ej. 'rateLimitGeneral').
 * @param {(req: import('express').Request) => string} obtenerClave - la
 *   misma función usada como `keyGenerator` de ese limiter — se reinvoca
 *   acá (pura, sin efectos secundarios) solo para loguear CONTRA QUÉ clave
 *   se bloqueó, sin depender de que express-rate-limit exponga la clave ya
 *   calculada en `optionsUsed`.
 * @returns {import('express-rate-limit').RateLimitRequestHandler['handler']}
 */
function crearHandlerBloqueo(nombre, obtenerClave) {
  return (req, res, _next, options) => {
    logger.warn(`[rateLimit] ${nombre} bloqueó una request`, {
      clave: obtenerClave(req),
      ip: req.ip,
      method: req.method,
      path: req.originalUrl,
    });
    res.status(options.statusCode).json(options.message);
  };
}

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
 * Excluye /api/v1/auth/* de `rateLimitGeneral` (ver Bloque A del diagnóstico
 * post-hardening, docs/post-hardening-diagnostico/, 16-17/sep/2026).
 *
 * Incidente real confirmado en producción: `rateLimitGeneral` es un único
 * balde de 100 requests/15min POR USUARIO compartido entre TODA la API
 * (`/api/v1/leads`, `/pipeline`, `/stats`, `/businesses/current`, etc. Y
 * `/auth/*`). Una sesión normal de dashboard (varios widgets pidiendo datos
 * casi en simultáneo) agota ese balde en menos de 2 minutos de uso legítimo.
 * Como `apiFetch` (crea-os-ignite-main, client.ts) adjuntaba el
 * `Authorization: Bearer` incluso en `/auth/login`, y `claveRateLimitGeneral`
 * decodifica ese header con `ignoreExpiration:true`, el siguiente intento de
 * login del MISMO usuario cae en el mismo balde ya agotado por el dashboard
 * → "Demasiadas solicitudes" al querer volver a entrar, sin haber hecho
 * fuerza bruta ni nada abusivo.
 *
 * /auth/* pasa a tener su propio balde (`rateLimitAuthGeneral`, más abajo),
 * separado del de recursos de negocio. `rateLimitLogin` (por email, mucho
 * más estricto, pensado para fuerza bruta) sigue corriendo TAL CUAL, sin
 * cambios, específicamente en `/login` — esto no lo reemplaza ni lo afloja.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function debeOmitirRateLimitGeneral(req) {
  return req.originalUrl.startsWith('/api/v1/auth');
}

/**
 * Rate limit global para las rutas de negocio de la API (todo excepto
 * /api/v1/auth/*, ver debeOmitirRateLimitGeneral() arriba).
 * 100 requests por 15 minutos — por usuario autenticado si se puede
 * identificar uno (ver claveRateLimitGeneral()), por IP si no.
 */
const rateLimitGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: debeOmitirRateLimitGeneral,
  keyGenerator: claveRateLimitGeneral,
  handler: crearHandlerBloqueo('rateLimitGeneral', claveRateLimitGeneral),
  message: {
    success: false,
    message: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.',
  },
});

/**
 * Rate limit general de /api/v1/auth/* — balde propio, separado por completo
 * de `rateLimitGeneral` (ver debeOmitirRateLimitGeneral() arriba). Por IP:
 * estos endpoints corren antes de que exista sesión (login, register) o
 * identifican la sesión por la cookie HttpOnly, no por el access token
 * (refresh, logout) — no hay un `userId` fiable y anterior a la sesión para
 * usar de clave.
 *
 * `rateLimitLogin`, `rateLimitRegister` y `rateLimitForgotPassword` (más
 * abajo) siguen corriendo ADEMÁS de este, en sus rutas específicas, con
 * límites más estrictos pensados para fuerza bruta/spam. Este es un techo
 * más generoso encima de TODO /auth/*, incluyendo rutas que hoy no tenían
 * ningún límite propio (refresh, logout, verify-email, reset-password).
 */
const rateLimitAuthGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: crearHandlerBloqueo('rateLimitAuthGeneral', (req) => req.ip),
  message: {
    success: false,
    message: 'Demasiadas solicitudes de autenticación. Intenta de nuevo en 15 minutos.',
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
function claveRateLimitLogin(req) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  // Sin email (body malformado/vacío — rateLimitLogin corre ANTES que
  // validarLogin en la ruta, ver auth.routes.js) cae a IP, mismo criterio
  // de antes — ese caso de todas formas lo rechaza el validator después.
  return email || req.ip;
}

const rateLimitLogin = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // No contar logins exitosos
  keyGenerator: claveRateLimitLogin,
  handler: crearHandlerBloqueo('rateLimitLogin', claveRateLimitLogin),
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
  rateLimitAuthGeneral,
  rateLimitLogin,
  rateLimitForgotPassword,
  rateLimitRegister,
  rateLimitMissionRegenerate,
  // Exportadas aparte para poder testear la lógica de la clave y del
  // logueo de bloqueo sin tener que simular requests reales contra el
  // rate limiter completo.
  claveRateLimitGeneral,
  claveRateLimitLogin,
  debeOmitirRateLimitGeneral,
  crearHandlerBloqueo,
};
