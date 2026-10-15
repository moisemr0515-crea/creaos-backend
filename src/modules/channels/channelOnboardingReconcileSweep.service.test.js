// Test real (Jest, Mongo real en base propia, Meta/Gupshup mockeados enteros) del
// barrido automático de conciliación del onboarding de WhatsApp —
// channelOnboardingReconcileSweep.service.js (incidente de Nutriva, 14/oct/2026).
// Cubre: elegibilidad, estados que activan/esperan/detienen, backoff, límite de
// frecuencia, concurrencia, prioridad del webhook, aislamiento entre tenants y que
// el barrido NUNCA crea apps/WABAs/sesiones. Nada pega contra Meta ni Gupshup.
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');

jest.mock('./providers/meta/metaEmbeddedSignup.service');
jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');
jest.mock('./providers/gupshup/partner/partner.subscriptions');
jest.mock('./standardTemplate.service');

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const channelCrypto = require('./channelCrypto');
const metaEmbeddedSignup = require('./providers/meta/metaEmbeddedSignup.service');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const standardTemplateService = require('./standardTemplate.service');
const { handleGupshupAccountVerified } = require('./channelOnboardingCompletion.service');
const { recoverPendingSession } = require('./channelOnboardingRecovery.service');
const {
  sweepPendingOnboardingSessions,
  BACKOFF_SCHEDULE_MS,
  FIRST_POLL_DELAY_MS,
  IN_PROGRESS_RETRY_MS,
  RATE_LIMIT_PAUSE_MS,
} = require('./channelOnboardingReconcileSweep.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_reconcile_sweep';
const MIN = 60 * 1000;
const DIA = 24 * 60 * MIN;
const TEL_NUEVO = '+51900000101';
const TEL_VIEJO = '+51900000202';
const hace = (ms) => new Date(Date.now() - ms);

const infoLive = (overrides = {}) => ({
  phone: '51900000101', phoneId: 'pnid-definitivo', wabaId: 'waba-definitiva', wabaName: 'Nutriva', accountStatus: 'ACTIVE', ...overrides,
});
const appNoLive = () => Object.assign(
  new Error('Gupshup Partner API rechazó la solicitud (getWabaInfo): App is not live.'),
  { statusCode: 400 }
);

describe('channelOnboardingReconcileSweep — barrido automático de conciliación', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await ChannelCredentials.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await ChannelCredentials.deleteMany({});
    await Business.deleteMany({});
    jest.clearAllMocks();
    jest.restoreAllMocks();
    tenantA = await Business.create({ name: 'Tenant A (Nutriva)' });
    tenantB = await Business.create({ name: 'Tenant B (otro cliente)' });
    standardTemplateService.ensureStandardTemplatesForChannel.mockResolvedValue({ created: [], catalog: [] });
    partnerAuth.getValidToken.mockResolvedValue('partner-token');
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-de-la-app' });
    partnerApps.getWabaInfo.mockResolvedValue(infoLive());
  });

  // Sesión pendiente "de libro": autorización de Meta completa, app propia, link
  // generado hace 10 min (ya pasó la espera que le da prioridad al webhook).
  const sesionPendiente = (tenant, { gupshup = {}, meta = {}, reconcile, ...overrides } = {}) => ChannelOnboardingSession.create({
    tenantId: tenant._id,
    status: 'gupshup_registering',
    displayName: 'Línea Nutriva',
    meta: {
      wabaId: '1000000000000101',
      phoneNumberId: '1000000000000501',
      phoneNumber: TEL_NUEVO,
      metaBusinessId: '1000000000000201',
      accessTokenCipher: channelCrypto.encrypt('token-meta', 'onboarding:placeholder'),
      ...meta,
    },
    gupshup: {
      appId: `app-${new mongoose.Types.ObjectId()}`,
      appName: 'creaosnueva',
      webhookReference: 'gupshup:account-subscribed',
      messagesWebhookReference: 'gupshup:messages-subscribed',
      embedSignupUrl: 'https://embed.gupshup.io/xyz',
      embedSignupUrlGeneratedAt: hace(10 * MIN),
      ...gupshup,
    },
    ...(reconcile ? { reconcile } : {}),
    // Como en el flujo real, complete-gupshup/callback extienden la ventana de la
    // sesión (GUPSHUP_PHASE_WINDOW_MS); aquí se deja amplia para que los tests que
    // adelantan el reloj sigan aislando la regla que prueban. Las pruebas de
    // expiración la pisan explícitamente.
    expiresAt: new Date(Date.now() + 30 * DIA),
    ...overrides,
  });

  const recargar = (sesion) => ChannelOnboardingSession.findById(sesion._id);

  describe('elegibilidad: solo sesiones pendientes con autorización de Meta completa e incorporación válida', () => {
    test('elegible: se concilia y, con la app Live y el número exacto, se activa el canal', async () => {
      const sesion = await sesionPendiente(tenantA);

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen).toMatchObject({ revisadas: 1, completadas: 1, pendientes: 0, detenidas: 0, errores: 0 });
      const r = await recargar(sesion);
      expect(r.status).toBe('completed');
      expect(r.completedVia).toBe('reconcile');
      expect(r.reconcile.stoppedReason).toBe('completed');
      expect(r.reconcile.nextAttemptAt).toBeNull();
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id, status: 'active' })).toBe(1);
    });

    test('NO elegibles — ninguna se consulta ni se modifica: otros estados, sin app, sin link, autorización de Meta incompleta, link reciente (prioridad al webhook), link vencido (>5 días), detenida, o con próximo intento futuro', async () => {
      const noElegibles = [
        await sesionPendiente(tenantA, { status: 'initiated' }),
        await sesionPendiente(tenantA, { status: 'meta_authorized' }),
        await sesionPendiente(tenantA, { status: 'failed', error: { step: 'gupshup_registration', message: 'x' } }),
        await sesionPendiente(tenantA, { status: 'expired' }),
        await sesionPendiente(tenantA, { status: 'completed' }),
        await sesionPendiente(tenantA, { gupshup: { appId: null } }),
        await sesionPendiente(tenantA, { gupshup: { embedSignupUrlGeneratedAt: null } }),
        await sesionPendiente(tenantA, { meta: { phoneNumber: null } }),
        await sesionPendiente(tenantA, { meta: { wabaId: null } }),
        await sesionPendiente(tenantA, { meta: { phoneNumberId: null } }),
        await sesionPendiente(tenantA, { gupshup: { embedSignupUrlGeneratedAt: hace(1 * MIN) } }), // el webhook tiene prioridad
        await sesionPendiente(tenantA, { gupshup: { embedSignupUrlGeneratedAt: hace(6 * DIA) } }), // pasó el plazo máximo
        await sesionPendiente(tenantA, { reconcile: { stoppedAt: new Date(), stoppedReason: 'mismatch' } }),
        await sesionPendiente(tenantA, { reconcile: { nextAttemptAt: new Date(Date.now() + 10 * MIN) } }),
      ];

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.revisadas).toBe(0);
      expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      for (const s of noElegibles) expect((await recargar(s)).reconcile.attempts).toBe(0);
    });

    test('prioridad del webhook: no consulta antes de FIRST_POLL_DELAY_MS desde el link; pasada la espera, sí', async () => {
      const sesion = await sesionPendiente(tenantA, { gupshup: { embedSignupUrlGeneratedAt: hace(FIRST_POLL_DELAY_MS - 30 * 1000) } });
      expect((await sweepPendingOnboardingSessions()).revisadas).toBe(0);

      const masTarde = new Date(Date.now() + 60 * 1000);
      expect((await sweepPendingOnboardingSessions({ now: masTarde })).revisadas).toBe(1);
      expect((await recargar(sesion)).reconcile.attempts).toBe(1);
    });

    test('si el webhook ya completó la sesión, el barrido ni la ve: Gupshup se consulta una sola vez (la del webhook)', async () => {
      const sesion = await sesionPendiente(tenantA, { gupshup: { appId: 'app-del-webhook' } });
      await handleGupshupAccountVerified('app-del-webhook');
      expect((await recargar(sesion)).status).toBe('completed');

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).toHaveBeenCalledTimes(1);
      expect((await recargar(sesion)).completedVia).toBe('webhook');
    });
  });

  describe('estados: qué activa, qué espera, qué detiene', () => {
    test('ESPERA — app todavía no Live ("App is not live"): pendiente, backoff de 2 min, sesión y token de Meta intactos', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());
      const now = new Date();

      const resumen = await sweepPendingOnboardingSessions({ now });

      expect(resumen).toMatchObject({ revisadas: 1, pendientes: 1, completadas: 0 });
      const r = await recargar(sesion);
      expect(r.status).toBe('gupshup_registering');
      expect(r.reconcile.attempts).toBe(1);
      expect(r.reconcile.lastOutcome).toBe('pending');
      expect(r.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + BACKOFF_SCHEDULE_MS[0]);
      expect(r.reconcile.stoppedAt).toBeNull();
      expect(r.meta.accessTokenCipher).not.toBeNull();
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('ESPERA — estado distinto de ACTIVE: se mantiene pendiente y el diagnóstico queda registrado (sin activar)', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ accountStatus: 'PENDING', dockerStatus: 'DISCONNECTED' }));

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.pendientes).toBe(1);
      const r = await recargar(sesion);
      expect(r.status).toBe('gupshup_registering');
      expect(r.reconcile.lastDiagnostic).toContain('reason=estado_no_activo');
      expect(r.reconcile.lastDiagnostic).toContain('accountStatus=PENDING');
      expect(r.reconcile.lastDiagnostic).toContain('dockerStatus=DISCONNECTED');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('ESPERA — información insuficiente (200 sin datos, o sin los IDs definitivos de Gupshup): pendiente, nunca se activa por un 200', async () => {
      const sesion = await sesionPendiente(tenantA);

      partnerApps.getWabaInfo.mockResolvedValue(undefined);
      await sweepPendingOnboardingSessions();
      expect((await recargar(sesion)).reconcile.lastDiagnostic).toContain('reason=informacion_insuficiente');

      partnerApps.getWabaInfo.mockResolvedValue({ phone: '51900000101', accountStatus: 'ACTIVE' }); // sin wabaId/phoneId
      await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 40 * MIN) });
      const r = await recargar(sesion);
      expect(r.reconcile.lastDiagnostic).toContain('reason=informacion_insuficiente');
      expect(r.reconcile.attempts).toBe(2);
      expect(r.status).toBe('gupshup_registering');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('ERROR transitorio de Gupshup: la sesión no cambia de estado y se reintenta con backoff', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(Object.assign(new Error('Gupshup Partner API no respondió'), { statusCode: 504 }));
      const now = new Date();

      const resumen = await sweepPendingOnboardingSessions({ now });

      expect(resumen).toMatchObject({ revisadas: 1, errores: 1 });
      const r = await recargar(sesion);
      expect(r.status).toBe('gupshup_registering');
      expect(r.error.step).toBeNull();
      expect(r.reconcile.lastDiagnostic).toContain('statusCode=504');
      expect(r.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + BACKOFF_SCHEDULE_MS[0]);
    });

    test('ERROR 429 del Partner API: se pausa 10 min y se corta el despertar (las demás sesiones no se consultan)', async () => {
      const primera = await sesionPendiente(tenantA);
      const segunda = await sesionPendiente(tenantA);
      partnerApps.getAppAccessToken.mockRejectedValue(Object.assign(new Error('rate limit'), { statusCode: 429 }));
      const now = new Date();

      const resumen = await sweepPendingOnboardingSessions({ now });

      expect(resumen).toMatchObject({ revisadas: 1, pausadoPorLimiteDeFrecuencia: true });
      const tocadas = [await recargar(primera), await recargar(segunda)];
      const consultada = tocadas.find((s) => s.reconcile.attempts === 1);
      const intacta = tocadas.find((s) => s.reconcile.attempts === 0);
      expect(consultada.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + RATE_LIMIT_PAUSE_MS);
      expect(intacta).toBeDefined();
      expect(partnerApps.getAppAccessToken).toHaveBeenCalledTimes(1);
    });

    test('DETIENE — la app está Live con OTRO número (mismatch): no activa, deja diagnóstico y NO vuelve a consultar', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ phone: '51900000202', phoneId: '1000000000000601' }));

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen).toMatchObject({ revisadas: 1, detenidas: 1, completadas: 0 });
      const r = await recargar(sesion);
      expect(r.status).toBe('gupshup_registering'); // recuperable, nunca 'completing' ni 'failed'
      expect(r.reconcile.stoppedReason).toBe('mismatch');
      expect(r.reconcile.lastDiagnostic).toContain(`expected=${TEL_NUEVO}`);
      expect(r.reconcile.lastDiagnostic).toContain(`found=${TEL_VIEJO}`);
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);

      partnerApps.getWabaInfo.mockClear();
      const otra = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 2 * DIA) });
      expect(otra.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('DETIENE — la WABA o el número ya pertenecen a OTRO tenant (identity_conflict): no activa y no toca el canal ajeno', async () => {
      const ajeno = await WhatsAppChannel.create({
        tenantId: tenantB._id, businessId: tenantB._id, connectionType: 'DEDICATED', status: 'active', onboardingStatus: 'completed',
        outboundApi: 'partner', phoneNumber: '+51988888888', phoneNumberId: 'otro-phone', wabaId: 'waba-definitiva', providerAppId: 'app-de-B',
      });
      const sesion = await sesionPendiente(tenantA);

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.detenidas).toBe(1);
      const r = await recargar(sesion);
      expect(r.status).toBe('gupshup_registering');
      expect(r.reconcile.stoppedReason).toBe('identity_conflict');
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(0);
      expect((await WhatsAppChannel.findById(ajeno._id)).tenantId.toString()).toBe(tenantB._id.toString());
    });

    test('DETIENE — la app de la sesión está ligada a un canal de otro número del tenant (app_unsafe): sin consultar a Gupshup', async () => {
      await WhatsAppChannel.create({
        tenantId: tenantA._id, businessId: tenantA._id, connectionType: 'DEDICATED', status: 'disconnected', onboardingStatus: 'completed',
        outboundApi: 'partner', phoneNumber: TEL_VIEJO, phoneNumberId: '1000000000000601', providerAppId: 'app-4f81',
      });
      const sesion = await sesionPendiente(tenantA, { gupshup: { appId: 'app-4f81' } });

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.detenidas).toBe(1);
      expect((await recargar(sesion)).reconcile.stoppedReason).toBe('app_unsafe');
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('DETIENE — falla al ACTIVAR (el número ya tiene un canal ACTIVO del tenant en otra app): excepción registrada, sesión failed/channel_creation, el barrido no insiste', async () => {
      await WhatsAppChannel.create({
        tenantId: tenantA._id, businessId: tenantA._id, connectionType: 'DEDICATED', status: 'active', onboardingStatus: 'completed',
        outboundApi: 'partner', phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero',
      });
      const sesion = await sesionPendiente(tenantA);

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.detenidas).toBe(1);
      const r = await recargar(sesion);
      expect(r.status).toBe('failed');
      expect(r.error.step).toBe('channel_creation');
      expect(r.reconcile.stoppedReason).toBe('excepcion_al_activar');
      expect((await sweepPendingOnboardingSessions({ now: new Date(Date.now() + DIA) })).revisadas).toBe(0);
    });

    test('el diagnóstico guardado es corto y nunca incluye apikeys ni tokens', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(Object.assign(new Error('x'.repeat(2000)), { statusCode: 500 }));

      await sweepPendingOnboardingSessions();

      const { lastDiagnostic } = (await recargar(sesion)).reconcile;
      expect(lastDiagnostic.length).toBeLessThanOrEqual(300);
      expect(lastDiagnostic).not.toMatch(/apikey-de-la-app|partner-token|token-meta/);
    });
  });

  describe('frecuencia: backoff, plazo y tope por despertar', () => {
    test('calendario de backoff por sesión: 2, 5, 10, 20, 30 y 30 min', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());
      let now = new Date();
      const esperas = [];

      for (let i = 0; i < 6; i += 1) {
        await sweepPendingOnboardingSessions({ now });
        const r = await recargar(sesion);
        esperas.push(r.reconcile.nextAttemptAt.getTime() - now.getTime());
        now = new Date(r.reconcile.nextAttemptAt.getTime()); // el instante exacto en que vuelve a vencer
      }

      expect(esperas).toEqual([2, 5, 10, 20, 30, 30].map((m) => m * MIN));
      expect((await recargar(sesion)).reconcile.attempts).toBe(6);
    });

    test('no consulta antes de que venza el backoff', async () => {
      await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());
      const now = new Date();
      await sweepPendingOnboardingSessions({ now });
      partnerApps.getWabaInfo.mockClear();

      const antes = await sweepPendingOnboardingSessions({ now: new Date(now.getTime() + 1 * MIN) });

      expect(antes.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('plazo máximo: pasada la vigencia del link (5 días) deja de consultar', async () => {
      await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());

      const alSextoDia = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 6 * DIA) });

      expect(alSextoDia.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('tope por despertar: con 5 sesiones vencidas y batchSize 2 consulta solo 2; las demás quedan intactas para el siguiente tick', async () => {
      const sesiones = [];
      for (let i = 0; i < 5; i += 1) sesiones.push(await sesionPendiente(tenantA));
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());

      const resumen = await sweepPendingOnboardingSessions({ batchSize: 2 });

      expect(resumen.revisadas).toBe(2);
      expect(partnerApps.getWabaInfo).toHaveBeenCalledTimes(2);
      const intentos = (await Promise.all(sesiones.map(recargar))).map((s) => s.reconcile.attempts).sort();
      expect(intentos).toEqual([0, 0, 0, 1, 1]);
    });
  });

  describe('concurrencia e idempotencia', () => {
    // Una app/número distintos por sesión, resueltos por appId.
    async function tresSesionesConSuNumero() {
      const sesiones = [];
      const porApp = {};
      for (let i = 0; i < 3; i += 1) {
        const appId = `app-concurrente-${i}`;
        const numero = `5191000000${i}`;
        porApp[appId] = infoLive({ phone: numero, phoneId: `pnid-${i}`, wabaId: `waba-${i}` });
        sesiones.push(await sesionPendiente(tenantA, { gupshup: { appId }, meta: { phoneNumber: `+${numero}`, phoneNumberId: `meta-pnid-${i}` } }));
      }
      partnerApps.getWabaInfo.mockImplementation(async (appId) => porApp[appId]);
      return sesiones;
    }

    test('dos barridos simultáneos: cada sesión se consulta UNA sola vez y hay un canal por sesión, sin duplicados', async () => {
      const sesiones = await tresSesionesConSuNumero();

      const [a, b] = await Promise.all([
        sweepPendingOnboardingSessions({ batchSize: 3 }),
        sweepPendingOnboardingSessions({ batchSize: 3 }),
      ]);

      expect(a.revisadas + b.revisadas).toBe(3);
      expect(partnerApps.getWabaInfo).toHaveBeenCalledTimes(3);
      expect(await WhatsAppChannel.countDocuments({})).toBe(3);
      expect(await ChannelCredentials.countDocuments({})).toBe(3);
      for (const s of sesiones) expect((await recargar(s)).status).toBe('completed');
    });

    test('barrido + webhook al mismo tiempo sobre la misma sesión: un solo canal y una sola credencial', async () => {
      const sesion = await sesionPendiente(tenantA, { gupshup: { appId: 'app-carrera' } });

      await Promise.all([
        sweepPendingOnboardingSessions(),
        handleGupshupAccountVerified('app-carrera'),
      ]);

      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
      expect((await recargar(sesion)).status).toBe('completed');
    });

    test('arrendamiento: una sesión tomada por otra instancia (próximo intento futuro) no se consulta', async () => {
      await sesionPendiente(tenantA, { reconcile: { attempts: 1, nextAttemptAt: new Date(Date.now() + 2 * MIN) } });

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('un barrido repetido tras completar no consulta ni duplica nada', async () => {
      await sesionPendiente(tenantA);
      await sweepPendingOnboardingSessions();
      partnerApps.getWabaInfo.mockClear();

      const segundo = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + DIA) });

      expect(segundo.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
    });

    test('recuperar una sesión detenida reinicia su calendario: el barrido vuelve a considerarla', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ phone: '51900000202' })); // mismatch → se detiene
      await sweepPendingOnboardingSessions();
      expect((await recargar(sesion)).reconcile.stoppedReason).toBe('mismatch');

      await recoverPendingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      const recuperada = await recargar(sesion);
      expect(recuperada.reconcile.stoppedAt).toBeNull();
      expect(recuperada.reconcile.attempts).toBe(0);
    });
  });

  describe('sesiones expiradas: el barrido no las procesa ni las modifica (caso Nutriva)', () => {
    // Réplica del estado de producción: autorización de Meta completa, app antigua ya
    // Live con otro número, link reciente, pero expiresAt (ventana de 30 min) vencido.
    const sesionTipoNutriva = (overrides = {}) => sesionPendiente(tenantA, {
      expiresAt: hace(10 * 60 * MIN),
      gupshup: { appId: 'app-4f81-antigua' },
      ...overrides,
    });

    test('una sesión con expiresAt vencido no se consulta ni se muta (ni un solo campo), aunque todo lo demás sea elegible', async () => {
      const sesion = await sesionTipoNutriva();
      const antes = JSON.stringify((await recargar(sesion)).toObject());

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen.revisadas).toBe(0);
      expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(JSON.stringify((await recargar(sesion)).toObject())).toBe(antes);
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('tampoco se toma con el reloj adelantado: el filtro usa el "ahora" del barrido', async () => {
      const sesion = await sesionPendiente(tenantA, { expiresAt: new Date(Date.now() + 5 * MIN) });
      expect((await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 10 * MIN) })).revisadas).toBe(0);
      expect((await recargar(sesion)).reconcile.attempts).toBe(0);
    });

    test('la sesión vencida sigue siendo recuperable con el procedimiento específico, y recién ahí el barrido la considera', async () => {
      const sesion = await sesionTipoNutriva();
      await sweepPendingOnboardingSessions();
      expect((await recargar(sesion)).reconcile.attempts).toBe(0);

      const recuperacion = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(['recovered', 'already_ready']).toContain(recuperacion.outcome);
      expect((await recargar(sesion)).expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * DIA);
    });

    test('una recuperación NO salta los controles: la app antigua ligada a otro número se desvincula y el barrido no consulta nada con ella', async () => {
      await WhatsAppChannel.create({
        tenantId: tenantA._id, businessId: tenantA._id, connectionType: 'DEDICATED', status: 'disconnected', onboardingStatus: 'completed',
        outboundApi: 'partner', phoneNumber: TEL_VIEJO, phoneNumberId: '1000000000000601', providerAppId: 'app-4f81-antigua',
      });
      const sesion = await sesionTipoNutriva();

      const recuperacion = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      const resumen = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) });

      expect(recuperacion.appDetached).toBe(true);
      expect(resumen.revisadas).toBe(0); // sin app asignada no es elegible: falta /complete-gupshup con app segura
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id, status: 'active' })).toBe(0);
    });

    test('una sesión recuperada con la app segura sigue sujeta a TODAS las verificaciones: número distinto ⇒ no activa', async () => {
      const sesion = await sesionTipoNutriva({ gupshup: { appId: 'app-nueva-propia' } });
      await recoverPendingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ phone: '51900000202', phoneId: '1000000000000601' }));

      const resumen = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) });

      expect(resumen).toMatchObject({ revisadas: 1, completadas: 0, detenidas: 1 });
      expect((await recargar(sesion)).reconcile.stoppedReason).toBe('mismatch');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('una sesión recuperada con estado distinto de ACTIVE o WABA/número de otro tenant tampoco activa', async () => {
      const sesion = await sesionTipoNutriva({ gupshup: { appId: 'app-nueva-propia' } });
      await recoverPendingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ accountStatus: 'PENDING' }));
      await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) });
      expect((await recargar(sesion)).reconcile.lastDiagnostic).toContain('reason=estado_no_activo');

      await WhatsAppChannel.create({
        tenantId: tenantB._id, businessId: tenantB._id, connectionType: 'DEDICATED', status: 'active', onboardingStatus: 'completed',
        outboundApi: 'partner', phoneNumber: '+51988888888', phoneNumberId: 'otro', wabaId: 'waba-definitiva', providerAppId: 'app-de-B',
      });
      partnerApps.getWabaInfo.mockResolvedValue(infoLive());
      await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 60 * MIN) });

      expect((await recargar(sesion)).reconcile.stoppedReason).toBe('identity_conflict');
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(0);
    });

    test('la recuperación sigue acotada por tenant: otro tenant no puede reabrir la sesión', async () => {
      const sesion = await sesionTipoNutriva();
      await expect(recoverPendingSession({ sessionId: sesion._id, tenantId: tenantB._id })).rejects.toThrow('no encontrada');
      expect((await recargar(sesion)).expiresAt.getTime()).toBeLessThan(Date.now());
    });
  });

  describe('cuota global del Partner API: el barrido corre en segundo plano y respeta el cupo', () => {
    const { currentPriority, PRIORITY } = require('./providers/gupshup/partnerRateLimit');
    const errorLocal = (retryAfterMs) => Object.assign(new Error('Cupo local agotado'), { statusCode: 429, code: 'PARTNER_LOCAL_RATE_LIMIT', retryAfterMs });
    const errorLimitador = () => Object.assign(new Error('Redis no disponible'), { statusCode: 503, code: 'PARTNER_LIMITER_UNAVAILABLE' });

    test('todas las llamadas a Gupshup del barrido se hacen con prioridad "background" (cuota reducida, sin reintentos del cliente)', async () => {
      await sesionPendiente(tenantA);
      const prioridades = [];
      partnerAuth.getValidToken.mockImplementation(async () => { prioridades.push(currentPriority()); return 'partner-token'; });
      partnerApps.getAppAccessToken.mockImplementation(async () => { prioridades.push(currentPriority()); return { apikey: 'apikey-de-la-app' }; });
      partnerApps.getWabaInfo.mockImplementation(async () => { prioridades.push(currentPriority()); return infoLive(); });

      await sweepPendingOnboardingSessions();

      expect(prioridades).toEqual([PRIORITY.BACKGROUND, PRIORITY.BACKGROUND, PRIORITY.BACKGROUND]);
      expect(currentPriority()).toBe(PRIORITY.INTERACTIVE); // el contexto no se filtra fuera del barrido
    });

    test('cupo local agotado: corta el despertar, reprograma al liberarse el cupo (acotado) y el intento NO cuenta para el backoff', async () => {
      const primera = await sesionPendiente(tenantA);
      const segunda = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(errorLocal(20 * 1000));
      const now = new Date();

      const resumen = await sweepPendingOnboardingSessions({ now });

      expect(resumen).toMatchObject({ revisadas: 1, errores: 1, pausadoPorLimiteDeFrecuencia: true });
      expect(partnerApps.getWabaInfo).toHaveBeenCalledTimes(1);
      const sesiones = [await recargar(primera), await recargar(segunda)];
      const tocada = sesiones.find((s) => s.reconcile.nextAttemptAt);
      expect(tocada.reconcile.attempts).toBe(0);
      expect(tocada.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + 21 * 1000);
      expect(tocada.status).toBe('gupshup_registering');
      expect(tocada.reconcile.stoppedAt).toBeNull();
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('la espera por cupo local queda acotada entre 5 s y 60 s', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(errorLocal(0));
      let now = new Date();
      await sweepPendingOnboardingSessions({ now });
      expect((await recargar(sesion)).reconcile.nextAttemptAt.getTime() - now.getTime()).toBe(5 * 1000);

      partnerApps.getWabaInfo.mockRejectedValue(errorLocal(10 * 60 * 1000));
      now = new Date(now.getTime() + 10 * 1000);
      await sweepPendingOnboardingSessions({ now });
      expect((await recargar(sesion)).reconcile.nextAttemptAt.getTime() - now.getTime()).toBe(60 * 1000);
    });

    test('Redis/limitador caído: el barrido no lanza más solicitudes en ese despertar y reintenta a los 2 min sin consumir intentos', async () => {
      await sesionPendiente(tenantA);
      await sesionPendiente(tenantA);
      partnerAuth.getValidToken.mockRejectedValue(errorLimitador());
      const now = new Date();

      const resumen = await sweepPendingOnboardingSessions({ now });

      expect(resumen).toMatchObject({ revisadas: 1, errores: 1, pausadoPorLimiteDeFrecuencia: true });
      expect(partnerAuth.getValidToken).toHaveBeenCalledTimes(1);
      expect(partnerApps.getAppAccessToken).not.toHaveBeenCalled();
      const tocada = (await ChannelOnboardingSession.find({ 'reconcile.nextAttemptAt': { $ne: null } }))[0];
      expect(tocada.reconcile.attempts).toBe(0);
      expect(tocada.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + 2 * MIN);
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('un 429 REAL de Gupshup sigue pausando 10 min y sí cuenta el intento', async () => {
      const sesion = await sesionPendiente(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(Object.assign(new Error('rate limit'), { statusCode: 429 }));
      const now = new Date();

      await sweepPendingOnboardingSessions({ now });

      const r = await recargar(sesion);
      expect(r.reconcile.attempts).toBe(1);
      expect(r.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + RATE_LIMIT_PAUSE_MS);
    });
  });

  describe('carrera con el webhook y fallo posterior del webhook: el barrido sigue siendo el respaldo', () => {
    // El webhook reclama la sesión (-> 'completing') justo DESPUÉS de que el barrido la
    // arrendó y ANTES de que la conciliación la lea.
    const webhookReclamaTrasElArrendamiento = (sesion) => {
      const original = ChannelOnboardingSession.findOne.bind(ChannelOnboardingSession);
      return jest.spyOn(ChannelOnboardingSession, 'findOne').mockImplementationOnce(async (...args) => {
        await ChannelOnboardingSession.updateOne({ _id: sesion._id }, { $set: { status: 'completing' } });
        return original(...args);
      });
    };

    test('el barrido NO da por terminada una sesión "completing": queda pendiente (in_progress), se reintenta en 1 min y no se toca ni se crea nada', async () => {
      const sesion = await sesionPendiente(tenantA);
      webhookReclamaTrasElArrendamiento(sesion);
      const now = new Date();

      const resumen = await sweepPendingOnboardingSessions({ now });

      expect(resumen).toMatchObject({ revisadas: 1, pendientes: 1, detenidas: 0, errores: 0, completadas: 0 });
      const r = await recargar(sesion);
      expect(r.status).toBe('completing');
      expect(r.reconcile.stoppedAt).toBeNull();
      expect(r.reconcile.stoppedReason).toBeNull();
      expect(r.reconcile.lastOutcome).toBe('in_progress');
      expect(r.reconcile.nextAttemptAt.getTime()).toBe(now.getTime() + IN_PROGRESS_RETRY_MS);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('mientras la sesión está "completing" el barrido ni la ve; si el webhook la completa, no vuelve a consultar a Gupshup', async () => {
      const sesion = await sesionPendiente(tenantA, { gupshup: { appId: 'app-del-webhook' } });
      webhookReclamaTrasElArrendamiento(sesion);
      await sweepPendingOnboardingSessions();
      // El webhook sigue en curso: otro despertar adelantado no la considera (no es gupshup_registering).
      expect((await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) })).revisadas).toBe(0);

      // El webhook termina bien (se la devolvemos a su estado reclamable para que la complete el flujo real).
      await ChannelOnboardingSession.updateOne({ _id: sesion._id }, { $set: { status: 'gupshup_registering' } });
      await handleGupshupAccountVerified('app-del-webhook');
      partnerApps.getWabaInfo.mockClear();

      const despues = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 10 * MIN) });

      expect(despues.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect((await recargar(sesion)).completedVia).toBe('webhook');
    });

    test('el webhook REVIERTE por número distinto: la sesión vuelve a gupshup_registering y el barrido la retoma y decide con el estado real de Gupshup', async () => {
      const sesion = await sesionPendiente(tenantA, { gupshup: { appId: 'app-del-webhook' } });
      webhookReclamaTrasElArrendamiento(sesion);
      await sweepPendingOnboardingSessions();
      expect((await recargar(sesion)).status).toBe('completing');
      await ChannelOnboardingSession.updateOne({ _id: sesion._id }, { $set: { status: 'gupshup_registering' } });
      partnerApps.getWabaInfo.mockResolvedValueOnce(infoLive({ phone: '51900000202', phoneId: '1000000000000601' }));
      await handleGupshupAccountVerified('app-del-webhook'); // mismatch: no activa y devuelve la sesión
      expect((await recargar(sesion)).status).toBe('gupshup_registering');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);

      const resumen = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) });

      expect(resumen).toMatchObject({ revisadas: 1, completadas: 1 });
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect((await recargar(sesion)).completedVia).toBe('reconcile');
    });

    test('el webhook FALLA al crear el canal (failed/channel_creation): el barrido la reintenta, reutiliza el canal ya creado y completa sin duplicar', async () => {
      const sesion = await sesionPendiente(tenantA, { gupshup: { appId: 'app-del-webhook' } });
      webhookReclamaTrasElArrendamiento(sesion);
      await sweepPendingOnboardingSessions();
      await ChannelOnboardingSession.updateOne({ _id: sesion._id }, { $set: { status: 'gupshup_registering' } });
      const spy = jest.spyOn(ChannelCredentials, 'create').mockRejectedValueOnce(new Error('fallo simulado posterior del webhook'));
      await expect(handleGupshupAccountVerified('app-del-webhook')).rejects.toThrow('fallo simulado');
      let r = await recargar(sesion);
      expect(r.status).toBe('failed');
      expect(r.error.step).toBe('channel_creation');
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(0);
      spy.mockRestore();

      const resumen = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) });

      expect(resumen).toMatchObject({ revisadas: 1, completadas: 1 });
      r = await recargar(sesion);
      expect(r.status).toBe('completed');
      expect(r.completedVia).toBe('reconcile');
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
    });

    test('si el reintento del barrido también falla, se detiene (una sola vez) y no vuelve a insistir', async () => {
      const sesion = await sesionPendiente(tenantA, { status: 'failed', error: { step: 'channel_creation', message: 'fallo del webhook' } });
      jest.spyOn(ChannelCredentials, 'create').mockRejectedValue(new Error('sigue fallando'));

      const primero = await sweepPendingOnboardingSessions();
      expect(primero).toMatchObject({ revisadas: 1, detenidas: 1, completadas: 0 });
      expect((await recargar(sesion)).reconcile.stoppedReason).toBe('excepcion_al_activar');
      partnerApps.getWabaInfo.mockClear();

      const segundo = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 2 * DIA) });

      expect(segundo.revisadas).toBe(0);
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('aislamiento: reintentar la sesión fallida de un tenant no toca las sesiones ni los canales de otro', async () => {
      const fallidaA = await sesionPendiente(tenantA, { status: 'failed', error: { step: 'channel_creation', message: 'x' }, gupshup: { appId: 'app-de-A' } });
      const completingB = await sesionPendiente(tenantB, { status: 'completing', gupshup: { appId: 'app-de-B' }, meta: { phoneNumber: '+51911111111' } });

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen).toMatchObject({ revisadas: 1, completadas: 1 });
      expect((await recargar(fallidaA)).status).toBe('completed');
      expect((await recargar(completingB)).status).toBe('completing');
      const canales = await WhatsAppChannel.find({});
      expect(canales).toHaveLength(1);
      expect(canales[0].tenantId.toString()).toBe(tenantA._id.toString());
    });
  });

  describe('aislamiento multi-tenant', () => {
    test('dos tenants con sesiones pendientes: cada canal queda con SU tenantId y SU app; el problema de uno no frena al otro', async () => {
      const sesionA = await sesionPendiente(tenantA, { gupshup: { appId: 'app-de-A' } });
      const sesionB = await sesionPendiente(tenantB, { gupshup: { appId: 'app-de-B' }, meta: { phoneNumber: '+51911111111' } });
      partnerApps.getWabaInfo.mockImplementation(async (appId) => (
        appId === 'app-de-A' ? infoLive() : infoLive({ phone: '51999999999', phoneId: 'pnid-B', wabaId: 'waba-B' }) // B: Live con otro número
      ));

      const resumen = await sweepPendingOnboardingSessions();

      expect(resumen).toMatchObject({ revisadas: 2, completadas: 1, detenidas: 1 });
      const canales = await WhatsAppChannel.find({});
      expect(canales).toHaveLength(1);
      expect(canales[0].tenantId.toString()).toBe(tenantA._id.toString());
      expect(canales[0].providerAppId).toBe('app-de-A');
      expect((await recargar(sesionA)).status).toBe('completed');
      const b = await recargar(sesionB);
      expect(b.status).toBe('gupshup_registering');
      expect(b.reconcile.stoppedReason).toBe('mismatch');
    });
  });

  describe('el barrido jamás crea apps, WABAs, suscripciones, links ni sesiones', () => {
    test('tras barrer sesiones pendientes, detenidas y completadas: cero llamadas de creación a Gupshup/Meta y mismas sesiones', async () => {
      await sesionPendiente(tenantA);
      await sesionPendiente(tenantA, { meta: { phoneNumber: '+51922222222' } }); // mismatch con el número Live
      await sesionPendiente(tenantB, { reconcile: { nextAttemptAt: new Date(Date.now() + 10 * MIN) } });
      const sesionesAntes = await ChannelOnboardingSession.countDocuments({});

      await sweepPendingOnboardingSessions();

      expect(partnerApps.createApp).not.toHaveBeenCalled();
      expect(partnerApps.setContactDetails).not.toHaveBeenCalled();
      expect(partnerApps.getEmbedSignupLink).not.toHaveBeenCalled();
      expect(partnerApps.generateEmbedSignupLink).not.toHaveBeenCalled();
      expect(partnerApps.verifyAndAttachCreditLine).not.toHaveBeenCalled();
      expect(partnerApps.linkAppWithPartner).not.toHaveBeenCalled();
      expect(partnerSubscriptions.subscribeToEvents).not.toHaveBeenCalled();
      expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled();
      expect(metaEmbeddedSignup.resolvePhoneNumber).not.toHaveBeenCalled();
      expect(await ChannelOnboardingSession.countDocuments({})).toBe(sesionesAntes);
    });
  });
});
