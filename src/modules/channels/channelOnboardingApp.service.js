// channelOnboardingApp.service.js — qué app de Gupshup usa cada conexión de
// WhatsApp. Incidente de Nutriva (14/oct/2026): el onboarding asumía UNA app de
// Gupshup por tenant (`creaos${tenantId}`) y reutilizaba el appId de cualquier
// sesión previa sin mirar su estado. Una app de Gupshup queda atada a UNA WABA y
// UN número al hacerse Live; reusar la app Live del número anterior para un
// número nuevo hacía que Gupshup respondiera "admitido" con la incorporación que
// la app ya tenía (BM/WABA viejos), nunca disparaba ACCOUNT_VERIFIED y el canal
// nuevo no se creaba jamás.
//
// Regla de este módulo: una app SOLO se reutiliza si no está ligada a otro
// número ni a otro tenant. Si no hay ninguna segura, se crea una app
// independiente por conexión. Las apps anteriores NUNCA se modifican ni se
// borran: este módulo solo lee sus estados y desvincula la referencia dentro de
// la propia sesión.
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const logger = require('../../utils/logger');

const { RECONCILE_INITIAL_STATE } = ChannelOnboardingSession;

const APP_NAME_PREFIX = 'creaos';
// Tope de candidatas a evaluar contra Gupshup por intento — el Partner API tiene
// rate limit de 10 req/60s, y más allá de las más recientes no aporta.
const MAX_CANDIDATAS = 3;

// Nombre de la PRIMERA app de un tenant. Es el único nombre con el que se crearon
// todas las apps legacy, así que sigue siendo el fallback de las sesiones sin
// `gupshup.appName`.
// Puro alfanumérico a propósito: el guion cuenta como "carácter especial" y
// Gupshup lo rechaza (confirmado en vivo en PR-02).
function nombreAppGupshup(tenantId) {
  return `${APP_NAME_PREFIX}${tenantId}`;
}

// Nombre de una app adicional del mismo tenant. Determinístico por sesión: un
// retry de la MISMA sesión choca con 409 "Bot Already Exists" y se resuelve por
// nombre en vez de duplicar la app; sesiones distintas nunca comparten nombre.
function nombreAppUnico(tenantId, sessionId) {
  return `${APP_NAME_PREFIX}${tenantId}x${String(sessionId).slice(-8)}`;
}

// Número que esta conexión debe terminar teniendo. Flujo clásico: el que Meta devolvió en la ventana de CREA OS.
// Modo enlace único: el que declaró el cliente. En sesiones clásicas `declaredPhone` no existe, así que el
// comportamiento es idéntico al de antes.
function telefonoEsperado(session) {
  return session?.meta?.phoneNumber || session?.declaredPhone || null;
}

function esModoEnlace(session) {
  return session?.mode === 'gupshup_link';
}

function normalizarTelefono(value) {
  return String(value ?? '').replace(/\D/g, '');
}

// Identidad de la conexión = el número. Los IDs de WABA/phoneNumberId de Meta
// pueden diferir de los definitivos de Gupshup (Meta entrega WABA provisorio en el
// popup, ver known-issues.md PR-11), así que NO sirven para comparar.
function telefonosCoinciden(a, b) {
  const na = normalizarTelefono(a);
  return na.length > 0 && na === normalizarTelefono(b);
}

// partner.errors.js mapea el 400 "App is not live." de waba/info a un AppError 400.
function esAppNoLive(err) {
  return err?.statusCode === 400 && /not live/i.test(err.message || '');
}

/**
 * Chequeos SOLO locales (Mongo, sin llamar a Gupshup) de si `appId` puede servir a
 * la conexión de `session`. Siempre acotados por tenant — nunca se confía en que
 * un appId "venga" del tenant correcto.
 *
 * @returns {Promise<{ seguro: boolean, motivo?: string }>}
 */
async function evaluarAppLocal({ appId, session, tenantId, expectedPhone = null }) {
  // `expectedPhone` solo se usa en la recuperación explícita de un mismatch del
  // modo enlace: permite validar el número corregido ANTES de persistirlo. Los
  // demás callers conservan exactamente la identidad de la sesión.
  const telefono = expectedPhone || telefonoEsperado(session);

  const [canalAjeno, sesionAjena] = await Promise.all([
    WhatsAppChannel.exists({ providerAppId: appId, tenantId: { $ne: tenantId } }),
    ChannelOnboardingSession.exists({ 'gupshup.appId': appId, tenantId: { $ne: tenantId } }),
  ]);
  if (canalAjeno || sesionAjena) return { seguro: false, motivo: 'app_de_otro_tenant' };

  const canales = await WhatsAppChannel.find({ tenantId, providerAppId: appId }).select('phoneNumber').lean();
  if (canales.some((c) => !telefonosCoinciden(c.phoneNumber, telefono))) {
    return { seguro: false, motivo: 'app_ligada_a_canal_de_otro_numero' };
  }

  const enVuelo = await ChannelOnboardingSession.find({
    tenantId,
    _id: { $ne: session._id },
    'gupshup.appId': appId,
    status: { $in: ['gupshup_registering', 'completing'] },
  }).select('meta.phoneNumber declaredPhone').lean();
  if (enVuelo.some((s) => telefonoEsperado(s) && !telefonosCoinciden(telefonoEsperado(s), telefono))) {
    return { seguro: false, motivo: 'app_reservada_por_sesion_en_curso_de_otro_numero' };
  }

  return { seguro: true };
}

/**
 * Estado REAL de la app en Gupshup (GET waba/info, solo lectura). "App is not
 * live" significa que todavía no tiene WABA verificada → segura. Cualquier otro
 * error (red, 401, 5xx) se propaga: sin poder verificar, no se reutiliza (fail-closed).
 *
 * @returns {Promise<{ seguro: boolean, live: boolean, motivo?: string, telefonoLive?: string }>}
 */
async function evaluarAppRemota({ appId, session, token }) {
  const { apikey } = await partnerApps.getAppAccessToken(appId, token);
  try {
    const info = await partnerApps.getWabaInfo(appId, apikey);
    if (!info || !info.phone) return { seguro: true, live: false };
    if (telefonosCoinciden(info.phone, telefonoEsperado(session))) return { seguro: true, live: true };
    return {
      seguro: false,
      live: true,
      motivo: 'app_live_con_otro_numero',
      telefonoLive: `+${normalizarTelefono(info.phone)}`,
    };
  } catch (err) {
    if (esAppNoLive(err)) return { seguro: true, live: false };
    throw err;
  }
}

async function evaluarCandidata({ appId, session, tenantId, token }) {
  const local = await evaluarAppLocal({ appId, session, tenantId });
  if (!local.seguro) return local;
  const remota = await evaluarAppRemota({ appId, session, token });
  return remota.seguro ? { seguro: true } : remota;
}

/**
 * Desvincula la app de la SESIÓN (no toca la app en Gupshup ni ninguna otra
 * sesión): limpia todo lo que dependía de ese appId para que el próximo paso
 * seleccione o cree una app propia. Conserva sessionId, datos de Meta y el token
 * de Meta cifrado.
 */
async function desvincularApp(session) {
  session.gupshup.appId = null;
  session.gupshup.appName = null;
  session.gupshup.webhookReference = null;
  session.gupshup.messagesWebhookReference = null;
  session.gupshup.embedSignupUrl = null;
  session.gupshup.embedSignupUrlGeneratedAt = null;
  session.reconcile = { ...RECONCILE_INITIAL_STATE }; // sin app no hay nada que conciliar: el calendario arranca de cero
  await session.save();
}

// Crea la app con `nombres[0]`; si ya existe (409) la resuelve por nombre, pero
// solo la acepta si es segura. Si el nombre base está ocupado por una app
// insegura, cae al siguiente nombre (el único por sesión).
async function crearApp({ nombres, session, tenantId, token }) {
  let ultimoError = null;

  for (const nombre of nombres) {
    try {
      const { appId } = await partnerApps.createApp({ name: nombre }, token);
      return { appId, appName: nombre, origen: 'creada' };
    } catch (err) {
      if (err.statusCode !== 409) throw err;
      ultimoError = err;

      // "Creado afuera, no persistido adentro": ninguna sesión tenía el appId
      // guardado — resolverlo por nombre en vez de fallar. Mismo fallback de PR-11,
      // ahora con evaluación de seguridad antes de aceptarlo.
      const apps = await partnerApps.getPartnerApps(token);
      const existente = apps.find((a) => a.name === nombre);
      if (!existente) throw err;

      const evaluacion = await evaluarCandidata({ appId: existente.id, session, tenantId, token });
      if (evaluacion.seguro) return { appId: existente.id, appName: nombre, origen: 'resuelta_por_nombre' };

      logger.warn('[channelOnboardingApp] App existente con ese nombre no es segura para esta conexión — se prueba otro nombre', {
        tenantId: String(tenantId), sessionId: String(session._id), appId: existente.id, motivo: evaluacion.motivo,
      });
    }
  }

  throw ultimoError;
}

/**
 * Deja `session.gupshup.appId`/`appName` apuntando a una app segura para ESTA
 * conexión: reutiliza una candidata del mismo tenant si no está ligada a otro
 * número, o crea una independiente. Persiste en la sesión.
 *
 * @returns {Promise<{ appId: string, appName: string, origen: string }>}
 */
async function seleccionarOCrearApp({ session, tenantId, token }) {
  const [sesiones, canales] = await Promise.all([
    ChannelOnboardingSession.find({
      tenantId,
      _id: { $ne: session._id },
      'gupshup.appId': { $ne: null },
    }).sort({ createdAt: -1 }).select('gupshup.appId gupshup.appName').lean(),
    WhatsAppChannel.find({ tenantId, providerAppId: { $ne: null } }).select('providerAppId providerAccountId').lean(),
  ]);

  const vistas = new Set();
  const candidatas = [];
  for (const s of sesiones) {
    if (vistas.has(s.gupshup.appId)) continue;
    vistas.add(s.gupshup.appId);
    candidatas.push({ appId: s.gupshup.appId, appName: s.gupshup.appName || nombreAppGupshup(tenantId) });
  }
  for (const c of canales) {
    if (vistas.has(c.providerAppId)) continue;
    vistas.add(c.providerAppId);
    candidatas.push({ appId: c.providerAppId, appName: c.providerAccountId || nombreAppGupshup(tenantId) });
  }

  for (const candidata of candidatas.slice(0, MAX_CANDIDATAS)) {
    const evaluacion = await evaluarCandidata({ appId: candidata.appId, session, tenantId, token });
    if (!evaluacion.seguro) {
      logger.info('[channelOnboardingApp] App previa del tenant descartada para esta conexión', {
        tenantId: String(tenantId), sessionId: String(session._id), appId: candidata.appId, motivo: evaluacion.motivo,
      });
      continue;
    }
    session.gupshup.appId = candidata.appId;
    session.gupshup.appName = candidata.appName;
    await session.save();
    return { ...candidata, origen: 'reutilizada' };
  }

  // Si el tenant ya tuvo alguna app, el nombre base está ocupado por la primera
  // (todas las apps legacy lo llevan): se va directo al nombre único por sesión.
  const nombres = candidatas.length > 0
    ? [nombreAppUnico(tenantId, session._id)]
    : [nombreAppGupshup(tenantId), nombreAppUnico(tenantId, session._id)];

  const creada = await crearApp({ nombres, session, tenantId, token });
  session.gupshup.appId = creada.appId;
  session.gupshup.appName = creada.appName;
  // Se guarda ANTES de seguir — si algo de acá para abajo falla, un retry no
  // vuelve a crear la app.
  await session.save();
  return creada;
}

module.exports = {
  telefonoEsperado,
  esModoEnlace,
  nombreAppGupshup,
  nombreAppUnico,
  normalizarTelefono,
  telefonosCoinciden,
  esAppNoLive,
  evaluarAppLocal,
  evaluarAppRemota,
  desvincularApp,
  seleccionarOCrearApp,
};
