// Test real (Jest, Mongo real en base propia, Meta/Gupshup mockeados) de la
// conciliación y la finalización compartida de channelOnboardingCompletion.service.js
// — incidente de Nutriva (14/oct/2026). Cubre: C (webhook ACCOUNT_VERIFIED),
// D (webhook ausente → conciliación segura), aislamiento entre tenants,
// concurrencia/idempotencia y F (conexiones existentes intactas). Complementa a
// channelOnboardingCompletion.service.test.js, que cubre el camino del webhook.
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');

jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');
jest.mock('./standardTemplate.service');

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const Conversation = require('../ai/conversation.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const channelCrypto = require('./channelCrypto');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const standardTemplateService = require('./standardTemplate.service');
const { nombreAppGupshup, nombreAppUnico } = require('./channelOnboardingApp.service');
const { handleGupshupAccountVerified, reconcileOnboardingSession } = require('./channelOnboardingCompletion.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_reconcile';
const TEL_NUEVO = '+51900000101';
const TEL_VIEJO = '+51900000202';
const DIA_MS = 24 * 60 * 60 * 1000;

const INFO_LIVE_NUEVO = {
  phone: '51900000101', phoneId: 'pnid-definitivo', wabaId: 'waba-definitiva', wabaName: 'Nutriva', accountStatus: 'ACTIVE',
};
const appNoLive = () => Object.assign(
  new Error('Gupshup Partner API rechazó la solicitud (getWabaInfo de app app-nueva): App is not live.'),
  { statusCode: 400 }
);

describe('channelOnboardingCompletion — conciliación y finalización compartida', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await ChannelCredentials.deleteMany({});
    await Conversation.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await ChannelCredentials.deleteMany({});
    await Conversation.deleteMany({});
    await Business.deleteMany({});
    tenantA = await Business.create({ name: 'Tenant A (Nutriva)' });
    tenantB = await Business.create({ name: 'Tenant B (otro cliente)' });
    jest.clearAllMocks();
    standardTemplateService.ensureStandardTemplatesForChannel.mockResolvedValue({ created: [], catalog: [] });
    partnerAuth.getValidToken.mockResolvedValue('partner-token');
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-de-la-app' });
    partnerApps.getWabaInfo.mockResolvedValue(INFO_LIVE_NUEVO);
  });

  const sesionLista = (tenant, { gupshup = {}, meta = {}, ...overrides } = {}) => ChannelOnboardingSession.create({
    tenantId: tenant._id,
    status: 'gupshup_registering',
    displayName: 'Línea Nutriva',
    meta: {
      wabaId: '1000000000000101',
      phoneNumberId: '1000000000000501',
      phoneNumber: TEL_NUEVO,
      metaBusinessId: '1000000000000201',
      accessTokenCipher: channelCrypto.encrypt('token-meta-de-nutriva', 'onboarding:placeholder'),
      ...meta,
    },
    gupshup: {
      appId: 'app-nueva',
      appName: `creaos${tenant._id}xabcdef12`,
      webhookReference: 'gupshup:account-subscribed',
      messagesWebhookReference: 'gupshup:messages-subscribed',
      embedSignupUrl: 'https://embed.gupshup.io/xyz',
      embedSignupUrlGeneratedAt: new Date(),
      ...gupshup,
    },
    ...overrides,
  });

  const canalExistente = (tenant, overrides = {}) => WhatsAppChannel.create({
    tenantId: tenant._id,
    businessId: tenant._id,
    connectionType: 'DEDICATED',
    status: 'active',
    onboardingStatus: 'completed',
    outboundApi: 'partner',
    phoneNumber: TEL_VIEJO,
    phoneNumberId: `pnid-existente-${tenant._id}`,
    wabaId: '1000000000000301',
    providerAppId: 'app-vieja-live',
    providerAccountId: nombreAppGupshup(tenant._id),
    ...overrides,
  });

  const instantanea = async () => JSON.stringify({
    canales: (await WhatsAppChannel.find({}).sort({ _id: 1 }).lean()),
    creds: (await ChannelCredentials.find({}).sort({ _id: 1 }).lean()),
  });

  describe('D. webhook ausente: conciliación segura', () => {
    test('app Live con el número autorizado: crea el canal correcto, completa la sesión y conserva los IDs de Meta', async () => {
      const sesion = await sesionLista(tenantA);

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res.outcome).toBe('completed');
      const canal = await WhatsAppChannel.findOne({ tenantId: tenantA._id });
      expect(canal._id.toString()).toBe(res.channelId.toString());
      expect(canal.status).toBe('active');
      expect(canal.onboardingStatus).toBe('completed');
      expect(canal.outboundApi).toBe('partner');
      expect(canal.phoneNumber).toBe(TEL_NUEVO);
      expect(canal.phoneNumberId).toBe('pnid-definitivo'); // IDs definitivos de Gupshup, no los provisorios de Meta
      expect(canal.wabaId).toBe('waba-definitiva');
      expect(canal.providerAppId).toBe('app-nueva');
      expect(canal.providerAccountId).toBe(`creaos${tenantA._id}xabcdef12`); // nombre REAL de la app, no el base del tenant
      expect(canal.webhookReference).toBe('gupshup:account-subscribed');

      const cred = await ChannelCredentials.findOne({ channel: canal._id });
      expect(cred.tenantId.toString()).toBe(tenantA._id.toString());
      expect(channelCrypto.decrypt(cred.apiKeys[0].value, String(canal._id))).toBe('apikey-de-la-app');

      const refrescada = await ChannelOnboardingSession.findById(sesion._id);
      expect(refrescada.status).toBe('completed');
      expect(refrescada.completedVia).toBe('reconcile');
      expect(refrescada.channel.toString()).toBe(canal._id.toString());
      expect(refrescada.meta.wabaId).toBe('1000000000000101'); // IDs de Meta conservados
      expect(refrescada.meta.phoneNumberId).toBe('1000000000000501');
      expect(refrescada.meta.metaBusinessId).toBe('1000000000000201');
      expect(refrescada.meta.accessTokenCipher).toBeNull(); // higiene solo al completar
    });

    test('es idempotente: una segunda conciliación no vuelve a llamar a Gupshup ni duplica canal ni credenciales', async () => {
      const sesion = await sesionLista(tenantA);
      await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      const segunda = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(segunda.outcome).toBe('already_completed');
      expect(segunda.channelId).toBeTruthy();
      expect(partnerApps.getWabaInfo).toHaveBeenCalledTimes(1);
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
    });

    test('la app todavía no está Live ("App is not live"): pending, la sesión y el token de Meta quedan intactos', async () => {
      const sesion = await sesionLista(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res.outcome).toBe('pending');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('gupshup_registering');
      expect(r.meta.accessTokenCipher).not.toBeNull();
      expect(r.error.step).toBeNull();
    });

    test('un HTTP 200 sin datos de WABA, o con la cuenta no ACTIVE, NO activa nada', async () => {
      const sesion = await sesionLista(tenantA);

      partnerApps.getWabaInfo.mockResolvedValue(undefined); // 200 sin wabaInfo
      expect((await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id })).outcome).toBe('pending');

      partnerApps.getWabaInfo.mockResolvedValue({ ...INFO_LIVE_NUEVO, accountStatus: 'PENDING' });
      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      expect(res).toEqual({ outcome: 'pending', reason: 'estado_no_activo', accountStatus: 'PENDING', dockerStatus: null });

      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('gupshup_registering');
    });

    test('la app está Live con OTRO número (el caso de Nutriva): mismatch, no se crea ni reactiva ningún canal', async () => {
      const sesion = await sesionLista(tenantA);
      const viejo = await canalExistente(tenantA, { status: 'disconnected', phoneNumberId: '1000000000000601' });
      partnerApps.getWabaInfo.mockResolvedValue({
        phone: '51900000202', phoneId: '1000000000000601', wabaId: '1000000000000301', wabaName: 'Negocio Prueba 3', accountStatus: 'ACTIVE',
      });

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res).toEqual({ outcome: 'mismatch', expected: TEL_NUEVO, found: TEL_VIEJO });
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect((await WhatsAppChannel.findById(viejo._id)).status).toBe('disconnected'); // el canal viejo NO se reactiva
      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('gupshup_registering'); // jamás quedó en 'completing'
      expect(r.meta.accessTokenCipher).not.toBeNull();
    });

    test('error transitorio de Gupshup: outcome error, SIN mutar la sesión (no queda failed)', async () => {
      const sesion = await sesionLista(tenantA);
      partnerApps.getAppAccessToken.mockRejectedValue(Object.assign(new Error('Gupshup Partner API no respondió'), { statusCode: 504 }));

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res.outcome).toBe('error');
      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('gupshup_registering');
      expect(r.error.step).toBeNull();
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('NO aplica la expiración perezosa de 30 min del popup: una app Live con el número correcto se completa aunque expiresAt haya vencido', async () => {
      const sesion = await sesionLista(tenantA, { expiresAt: new Date(Date.now() - 60 * 60 * 1000) });

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res.outcome).toBe('completed');
    });

    test('reintenta una sesión "failed" en channel_creation (fallo parcial previo) y completa sin duplicar el canal', async () => {
      const sesion = await sesionLista(tenantA, { status: 'failed', error: { step: 'channel_creation', message: 'fallo transitorio' } });

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res.outcome).toBe('completed');
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect((await ChannelOnboardingSession.findById(sesion._id)).error.step).toBeNull();
    });

    test('sesiones que no se concilian: estado inválido, sin app, sin teléfono, link vencido — ninguna llama a Gupshup', async () => {
      const iniciada = await sesionLista(tenantA, { status: 'initiated' });
      const expirada = await sesionLista(tenantA, { status: 'expired' });
      const sinApp = await sesionLista(tenantA, { gupshup: { appId: null } });
      const sinTelefono = await sesionLista(tenantA, { meta: { phoneNumber: null } });
      const vencida = await sesionLista(tenantA, { gupshup: { embedSignupUrlGeneratedAt: new Date(Date.now() - 8 * DIA_MS) } });

      const r = (s) => reconcileOnboardingSession({ sessionId: s._id, tenantId: tenantA._id });
      expect(await r(iniciada)).toEqual({ outcome: 'invalid_state', status: 'initiated' });
      expect(await r(expirada)).toEqual({ outcome: 'invalid_state', status: 'expired' });
      expect(await r(sinApp)).toEqual({ outcome: 'not_ready', reason: 'sin_app_de_gupshup' });
      expect(await r(sinTelefono)).toEqual({ outcome: 'not_ready', reason: 'sin_telefono_autorizado_en_meta' });
      expect(await r(vencida)).toEqual({ outcome: 'stale' });

      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
    });

    test('app ligada a un canal de OTRO número del tenant: app_unsafe, no se consulta a Gupshup ni se crea nada', async () => {
      await canalExistente(tenantA, { providerAppId: 'app-nueva' }); // la app de la sesión sirve a +51900000202
      const sesion = await sesionLista(tenantA);

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res).toEqual({ outcome: 'app_unsafe', reason: 'app_ligada_a_canal_de_otro_numero' });
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
    });
  });

  describe('C. webhook ACCOUNT_VERIFIED', () => {
    test('camino feliz: completa con via "webhook" y el canal usa el nombre REAL de la app de la sesión', async () => {
      const sesion = await sesionLista(tenantA);

      await handleGupshupAccountVerified('app-nueva');

      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('completed');
      expect(r.completedVia).toBe('webhook');
      const canal = await WhatsAppChannel.findOne({ tenantId: tenantA._id });
      expect(canal.providerAccountId).toBe(`creaos${tenantA._id}xabcdef12`);
      expect(canal.phoneNumber).toBe(TEL_NUEVO);
    });

    test('sesión legacy sin gupshup.appName: providerAccountId cae al nombre determinístico por tenant (compatibilidad)', async () => {
      await sesionLista(tenantA, { gupshup: { appName: null } });

      await handleGupshupAccountVerified('app-nueva');

      expect((await WhatsAppChannel.findOne({ tenantId: tenantA._id })).providerAccountId).toBe(nombreAppGupshup(tenantA._id));
    });

    test('webhook de una app Live con otro número: no activa el canal y deja la sesión recuperable', async () => {
      const sesion = await sesionLista(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue({ ...INFO_LIVE_NUEVO, phone: '51900000202', phoneId: '1000000000000601' });

      await handleGupshupAccountVerified('app-nueva');

      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('gupshup_registering');
    });
  });

  describe('concurrencia e idempotencia', () => {
    test('webhook + dos conciliaciones simultáneas: un solo canal y una sola credencial', async () => {
      const sesion = await sesionLista(tenantA);

      const resultados = await Promise.all([
        reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id }),
        reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id }),
        handleGupshupAccountVerified('app-nueva'),
      ]);

      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('completed');
      // A lo sumo UNA conciliación completa (si ganó el webhook, ninguna); las
      // perdedoras nunca devuelven un estado que sugiera haber creado el canal.
      const [rec1, rec2] = resultados;
      expect([rec1, rec2].filter((x) => x.outcome === 'completed').length).toBeLessThanOrEqual(1);
      for (const rec of [rec1, rec2]) {
        expect(['completed', 'in_progress', 'already_completed']).toContain(rec.outcome);
      }
    });
  });

  describe('sesión en "completing" (otro actor la está terminando): espera, no error terminal', () => {
    const esperarHasta = async (condicion, ms = 3000) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if (await condicion()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('timeout esperando la condición');
    };

    test('conciliar una sesión "completing" es una espera (in_progress): no consulta a Gupshup, no toca la sesión y no crea nada', async () => {
      const sesion = await sesionLista(tenantA, { status: 'completing' });
      const antesSesion = JSON.stringify((await ChannelOnboardingSession.findById(sesion._id)).toObject());
      const antes = await instantanea();

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(res).toEqual({ outcome: 'in_progress' });
      expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect(await instantanea()).toBe(antes);
      expect(JSON.stringify((await ChannelOnboardingSession.findById(sesion._id)).toObject())).toBe(antesSesion);
    });

    test('con el tenant equivocado sigue siendo not_found (no revela el estado de una sesión ajena)', async () => {
      const sesion = await sesionLista(tenantA, { status: 'completing' });
      expect(await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantB._id })).toEqual({ outcome: 'not_found' });
    });

    test('los demás estados no conciliables siguen siendo invalid_state', async () => {
      for (const status of ['initiated', 'meta_authorized', 'expired']) {
        const s = await sesionLista(tenantA, { status });
        expect(await reconcileOnboardingSession({ sessionId: s._id, tenantId: tenantA._id })).toEqual({ outcome: 'invalid_state', status });
      }
    });

    test('carrera real repetida 15 veces (webhook + 2 conciliaciones): nunca invalid_state, un solo canal y una sola credencial en cada vuelta', async () => {
      for (let vuelta = 0; vuelta < 15; vuelta += 1) {
        await ChannelOnboardingSession.deleteMany({});
        await WhatsAppChannel.deleteMany({});
        await ChannelCredentials.deleteMany({});
        const sesion = await sesionLista(tenantA);

        const [rec1, rec2] = await Promise.all([
          reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id }),
          reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id }),
          handleGupshupAccountVerified('app-nueva'),
        ]);

        expect(['completed', 'in_progress', 'already_completed']).toContain(rec1.outcome);
        expect(['completed', 'in_progress', 'already_completed']).toContain(rec2.outcome);
        expect(await WhatsAppChannel.countDocuments({})).toBe(1);
        expect(await ChannelCredentials.countDocuments({})).toBe(1);
        expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('completed');
      }
    });

    test('el webhook FALLA después de que la conciliación lo vio en "completing": la conciliación esperó sin activar nada y luego recupera sin duplicar', async () => {
      const sesion = await sesionLista(tenantA);
      let compuertaAlcanzada = false;
      let liberar;
      const compuerta = new Promise((resolve) => { liberar = resolve; });
      // El webhook ya creó el canal; falla justo al crear las credenciales (limitación documentada).
      const spy = jest.spyOn(ChannelCredentials, 'create').mockImplementationOnce(async () => {
        compuertaAlcanzada = true;
        await compuerta;
        throw new Error('fallo simulado posterior del webhook');
      });

      const webhook = handleGupshupAccountVerified('app-nueva').catch((e) => e);
      await esperarHasta(() => compuertaAlcanzada);
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('completing');

      const durante = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      expect(durante).toEqual({ outcome: 'in_progress' });
      expect(partnerApps.getWabaInfo).toHaveBeenCalledTimes(1); // solo la del webhook
      expect(await WhatsAppChannel.countDocuments({})).toBe(1); // lo creó el webhook, no la conciliación

      liberar();
      const falloDelWebhook = await webhook;
      expect(falloDelWebhook).toBeInstanceOf(Error);
      let r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('failed');
      expect(r.error.step).toBe('channel_creation');
      expect(await ChannelCredentials.countDocuments({})).toBe(0);

      // Recuperación: la conciliación reclama la sesión fallida y reutiliza el canal ya creado.
      const reintento = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      expect(reintento.outcome).toBe('completed');
      r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('completed');
      expect(r.completedVia).toBe('reconcile');
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
      spy.mockRestore();
    });

    test('el webhook revierte por NÚMERO DISTINTO: la sesión vuelve a gupshup_registering y la conciliación decide con el estado real de Gupshup', async () => {
      const sesion = await sesionLista(tenantA);
      partnerApps.getWabaInfo.mockResolvedValueOnce({ ...INFO_LIVE_NUEVO, phone: '51900000202', phoneId: '1000000000000601' });

      await handleGupshupAccountVerified('app-nueva');
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('gupshup_registering');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);

      const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });
      expect(res.outcome).toBe('completed');
      expect(await WhatsAppChannel.countDocuments({})).toBe(1);
    });

    test('aislamiento: una sesión "completing" de otro tenant no se ve afectada por la conciliación de este', async () => {
      const sesionB = await sesionLista(tenantB, { status: 'completing', gupshup: { appId: 'app-de-B' } });
      const sesionA = await sesionLista(tenantA);

      await reconcileOnboardingSession({ sessionId: sesionA._id, tenantId: tenantA._id });

      expect((await ChannelOnboardingSession.findById(sesionB._id)).status).toBe('completing');
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantB._id })).toBe(0);
    });
  });

  describe('aislamiento multi-tenant', () => {
    test('conciliar con el tenant equivocado es "not_found": no llama a Gupshup ni toca la sesión ajena', async () => {
      const sesionB = await sesionLista(tenantB, { gupshup: { appId: 'app-de-B' } });

      const res = await reconcileOnboardingSession({ sessionId: sesionB._id, tenantId: tenantA._id });

      expect(res).toEqual({ outcome: 'not_found' });
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect((await ChannelOnboardingSession.findById(sesionB._id)).status).toBe('gupshup_registering');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('dos tenants con sesiones pendientes: conciliar uno completa SOLO su canal, con su tenantId', async () => {
      const sesionA = await sesionLista(tenantA, { gupshup: { appId: 'app-de-A' } });
      const sesionB = await sesionLista(tenantB, { meta: { phoneNumber: '+51911111111' }, gupshup: { appId: 'app-de-B' } });
      partnerApps.getWabaInfo.mockImplementation(async (appId) => (
        appId === 'app-de-A' ? INFO_LIVE_NUEVO : { ...INFO_LIVE_NUEVO, phone: '51911111111', phoneId: 'pnid-de-B' }
      ));

      await reconcileOnboardingSession({ sessionId: sesionA._id, tenantId: tenantA._id });

      const canales = await WhatsAppChannel.find({});
      expect(canales).toHaveLength(1);
      expect(canales[0].tenantId.toString()).toBe(tenantA._id.toString());
      expect(canales[0].providerAppId).toBe('app-de-A');
      expect((await ChannelOnboardingSession.findById(sesionB._id)).status).toBe('gupshup_registering');
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalledWith('app-de-B', expect.anything());
    });

    test('un número que ya pertenece a OTRO tenant se rechaza ANTES de reclamar: identity_conflict, el canal ajeno no se toca y la sesión queda intacta (recuperable)', async () => {
      const ajeno = await canalExistente(tenantB, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-de-B' });
      const sesion = await sesionLista(tenantA);
      const antes = await instantanea();

      const resultado = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      expect(resultado.outcome).toBe('identity_conflict');
      expect(await instantanea()).toBe(antes);
      expect((await WhatsAppChannel.findById(ajeno._id)).tenantId.toString()).toBe(tenantB._id.toString());
      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.status).toBe('gupshup_registering');
      expect(r.error.step).toBeNull();
    });
  });

  describe('F. regresión: conexiones existentes intactas', () => {
    test('completar una conexión nueva no modifica los canales ni credenciales existentes (del tenant ni de otros)', async () => {
      const activoDelTenant = await canalExistente(tenantA, { phoneNumber: '+51922222222', phoneNumberId: 'pnid-activo-A', providerAppId: 'app-activa-A', status: 'active' });
      const viejoDesconectado = await canalExistente(tenantA, { status: 'disconnected', phoneNumberId: '1000000000000601' });
      await canalExistente(tenantB, { phoneNumberId: 'pnid-de-B', providerAppId: 'app-de-B' });
      await ChannelCredentials.create({
        channel: activoDelTenant._id, tenantId: tenantA._id, provider: 'gupshup',
        apiKeys: [{ value: channelCrypto.encrypt('apikey-activa', String(activoDelTenant._id)) }],
      });
      const sesion = await sesionLista(tenantA);
      const antes = JSON.parse(await instantanea());

      await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

      const despues = JSON.parse(await instantanea());
      // Los 3 canales previos y la credencial previa quedan idénticos; solo se SUMA un canal y una credencial.
      expect(despues.canales).toHaveLength(antes.canales.length + 1);
      expect(despues.creds).toHaveLength(antes.creds.length + 1);
      for (const previo of antes.canales) expect(despues.canales).toContainEqual(previo);
      for (const previa of antes.creds) expect(despues.creds).toContainEqual(previa);
      expect((await WhatsAppChannel.findById(viejoDesconectado._id)).status).toBe('disconnected');
      expect((await WhatsAppChannel.findById(activoDelTenant._id)).status).toBe('active');
    });

    test('un canal ACTIVO del tenant servido por OTRA app es un conflicto real: no se reasigna solo y queda intacto', async () => {
      const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero', status: 'active' });
      const sesion = await sesionLista(tenantA);
      const antes = await instantanea();

      await expect(reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id }))
        .rejects.toThrow('otra aplicación de Gupshup');

      expect(await instantanea()).toBe(antes);
      expect((await WhatsAppChannel.findById(existente._id)).status).toBe('active');
    });

    describe('reconexión del MISMO número del MISMO tenant (autoservicio: desconectó y vuelve a conectar)', () => {
      const credencialesRevocadas = async (canal, apikey = 'apikey-vieja-de-la-app-anterior') => ChannelCredentials.create({
        channel: canal._id, tenantId: canal.tenantId, provider: 'gupshup',
        apiKeys: [{ value: channelCrypto.encrypt(apikey, String(canal._id)), revokedAt: new Date(), revokedReason: 'channel_disconnected' }],
      });
      const conversacion = (canal, tenant, extra = {}) => Conversation.create({
        business: tenant._id, tenantId: tenant._id, lead: new mongoose.Types.ObjectId(), channel: 'whatsapp',
        whatsappChannel: canal._id, whatsappChannelStatus: 'reassignment_required', ...extra,
      });

      test('canal desconectado en la app ANTERIOR: se reutiliza el mismo canal (sin duplicar), se re-liga a la app nueva y se activa con credenciales nuevas', async () => {
        const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero', providerAccountId: 'creaos-app-anterior', wabaId: 'waba-anterior', status: 'disconnected' });
        const credsViejas = await credencialesRevocadas(existente);
        const convDelCanal = await conversacion(existente, tenantA);
        const sesion = await sesionLista(tenantA);

        const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

        expect(res.outcome).toBe('completed');
        expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id, phoneNumberId: 'pnid-definitivo' })).toBe(1);
        const canal = await WhatsAppChannel.findById(existente._id);
        expect(canal.status).toBe('active');
        expect(canal.onboardingStatus).toBe('completed');
        expect(canal.outboundApi).toBe('partner');
        expect(canal.providerAppId).toBe('app-nueva');
        expect(canal.providerAccountId).toBe(`creaos${tenantA._id}xabcdef12`);
        expect(canal.wabaId).toBe('waba-definitiva');
        // credenciales: la key vieja queda revocada (historial) y hay UNA activa, de la app actual
        const creds = await ChannelCredentials.findById(credsViejas._id);
        expect(await ChannelCredentials.countDocuments({ channel: existente._id })).toBe(1);
        expect(creds.apiKeys).toHaveLength(2);
        expect(creds.apiKeys.filter((k) => !k.revokedAt)).toHaveLength(1);
        const { resolveCredentials } = require('./channelCredentials.service');
        expect((await resolveCredentials(canal)).apiKey).toBe('apikey-de-la-app');
        // las conversaciones del canal vuelven a estar operativas
        expect((await Conversation.findById(convDelCanal._id)).whatsappChannelStatus).toBe('ready');
        expect((await ChannelOnboardingSession.findById(sesion._id)).channel.toString()).toBe(existente._id.toString());
      });

      test('misma app pero con todas las keys revocadas al desconectar: se agrega una key activa nueva y el canal puede enviar', async () => {
        const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-nueva', status: 'disconnected' });
        await credencialesRevocadas(existente);
        const sesion = await sesionLista(tenantA);

        const res = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

        expect(res.outcome).toBe('completed');
        const canal = await WhatsAppChannel.findById(existente._id);
        expect(canal.status).toBe('active');
        const { resolveCredentials } = require('./channelCredentials.service');
        expect((await resolveCredentials(canal)).apiKey).toBe('apikey-de-la-app'); // antes: "todas las apiKeys están revocadas"
      });

      test('canal en estado "error" (activación fallida previa) también se reutiliza', async () => {
        const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero', status: 'error', onboardingStatus: 'failed' });
        await credencialesRevocadas(existente);
        const sesion = await sesionLista(tenantA);

        expect((await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id })).outcome).toBe('completed');
        expect((await WhatsAppChannel.findById(existente._id)).status).toBe('active');
      });

      test('aislamiento: no toca el canal ni las conversaciones de otro tenant, ni otros canales del mismo tenant', async () => {
        const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero', status: 'disconnected' });
        await credencialesRevocadas(existente);
        const otroDelTenant = await canalExistente(tenantA, { phoneNumberId: 'pnid-otro-del-tenant', providerAppId: 'app-activa-A', status: 'active' });
        const canalB = await canalExistente(tenantB, { phoneNumberId: 'pnid-de-B', providerAppId: 'app-de-B', status: 'disconnected' });
        const convB = await conversacion(canalB, tenantB);
        const convOtroCanal = await conversacion(otroDelTenant, tenantA);
        const snapB = JSON.stringify(await WhatsAppChannel.findById(canalB._id).lean());
        const snapOtro = JSON.stringify(await WhatsAppChannel.findById(otroDelTenant._id).lean());
        const sesion = await sesionLista(tenantA);

        await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

        expect(JSON.stringify(await WhatsAppChannel.findById(canalB._id).lean())).toBe(snapB);
        expect(JSON.stringify(await WhatsAppChannel.findById(otroDelTenant._id).lean())).toBe(snapOtro);
        expect((await Conversation.findById(convB._id)).whatsappChannelStatus).toBe('reassignment_required');
        expect((await Conversation.findById(convOtroCanal._id)).whatsappChannelStatus).toBe('reassignment_required');
      });

      test('el canal reutilizado ya lo referencia la sesión de la PRIMERA conexión (índice único): la reconexión se completa y deja constancia en reusedChannel', async () => {
        const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero', status: 'disconnected' });
        await credencialesRevocadas(existente);
        const primera = await sesionLista(tenantA, { status: 'completed', channel: existente._id, gupshup: { appId: 'app-anterior-del-mismo-numero' } });
        const nueva = await sesionLista(tenantA);

        const res = await reconcileOnboardingSession({ sessionId: nueva._id, tenantId: tenantA._id });

        expect(res.outcome).toBe('completed');
        const n = await ChannelOnboardingSession.findById(nueva._id);
        expect(n.status).toBe('completed');
        expect(n.channel).toBeUndefined();
        expect(String(n.reusedChannel)).toBe(String(existente._id));
        expect(String((await ChannelOnboardingSession.findById(primera._id)).channel)).toBe(String(existente._id)); // la primera sesión no se toca
        expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(1);
        // y reconciliar otra vez informa el canal correcto
        expect(String((await reconcileOnboardingSession({ sessionId: nueva._id, tenantId: tenantA._id })).channelId)).toBe(String(existente._id));
      });

      test('idempotencia: reconciliar de nuevo la sesión ya completada no agrega keys ni duplica nada', async () => {
        const existente = await canalExistente(tenantA, { phoneNumber: TEL_NUEVO, phoneNumberId: 'pnid-definitivo', providerAppId: 'app-anterior-del-mismo-numero', status: 'disconnected' });
        const creds = await credencialesRevocadas(existente);
        const sesion = await sesionLista(tenantA);
        await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

        const otra = await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id });

        expect(otra.outcome).toBe('already_completed');
        expect((await ChannelCredentials.findById(creds._id)).apiKeys).toHaveLength(2);
        expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(1);
      });
    });

    test('la sesión de onboarding previamente completada de otra conexión no se toca', async () => {
      const canalPrevio = await canalExistente(tenantA);
      const sesionPrevia = await sesionLista(tenantA, {
        status: 'completed', channel: canalPrevio._id,
        meta: { phoneNumber: TEL_VIEJO, wabaId: '1000000000000301', phoneNumberId: '1000000000000601', accessTokenCipher: null },
        gupshup: { appId: 'app-vieja-live', appName: nombreAppGupshup(tenantA._id) },
      });
      const instPrevia = JSON.stringify(await ChannelOnboardingSession.findById(sesionPrevia._id).lean());
      const nueva = await sesionLista(tenantA, { gupshup: { appId: 'app-nueva', appName: nombreAppUnico(tenantA._id, new mongoose.Types.ObjectId()) } });

      await reconcileOnboardingSession({ sessionId: nueva._id, tenantId: tenantA._id });

      expect(JSON.stringify(await ChannelOnboardingSession.findById(sesionPrevia._id).lean())).toBe(instPrevia);
    });
  });
});
