// Test real (Jest, Mongo real en base propia, Meta/Gupshup mockeados enteros) de
// los cambios de channel.controller.js del incidente de Nutriva (14/oct/2026):
// una app independiente por conexión, ventana de la fase Gupshup, businessId de
// Meta opcional en /callback y el endpoint de conciliación. Reproduce el estado
// real de producción (sesión pendiente atada a la app Live del número anterior).
// Complementa a channel.controller.test.js sin modificarlo.
process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = '';
process.env.META_APP_ID = process.env.META_APP_ID || 'meta-app-id-de-prueba';
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'https://backend.creaos.test';
process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN = process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN || 'onboarding-webhook-token-de-prueba';
process.env.GUPSHUP_WEBHOOK_TOKEN = process.env.GUPSHUP_WEBHOOK_TOKEN || 'webhook-token-de-prueba';

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
const { nombreAppUnico } = require('./channelOnboardingApp.service');
const { recoverPendingSession } = require('./channelOnboardingRecovery.service');
const {
  callbackEmbeddedSignup,
  completeGupshupEmbeddedSignup,
  reconcileEmbeddedSignup,
} = require('./channel.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_controller_app_isolation';
const DIA_MS = 24 * 60 * 60 * 1000;
const requester = { email: 'nutriva@creaos.test', name: 'Nutriva Corp' };

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const appNoLive = () => Object.assign(
  new Error('Gupshup Partner API rechazó la solicitud (getWabaInfo): App is not live.'),
  { statusCode: 400 }
);

// Todos los primeros argumentos (appId) con los que se llamó a cualquier función
// mockeada de Gupshup — para probar que una app NO recibió ninguna llamada.
function appIdsTocados() {
  const ids = new Set();
  for (const modulo of [partnerApps, partnerSubscriptions]) {
    for (const fn of Object.values(modulo)) {
      if (jest.isMockFunction(fn)) fn.mock.calls.forEach((args) => { if (typeof args[0] === 'string') ids.add(args[0]); });
    }
  }
  return ids;
}

describe('channel.controller — app independiente por conexión (incidente Nutriva)', () => {
  let tenant;
  let otroTenant;
  let canalViejo;

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
    tenant = await Business.create({ name: 'Negocio Prueba 2 (Nutriva)' });
    otroTenant = await Business.create({ name: 'Otro tenant' });

    partnerAuth.getValidToken.mockResolvedValue('partner-token');
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-de-la-app' });
    partnerApps.getWabaInfo.mockRejectedValue(appNoLive());
    partnerApps.createApp.mockResolvedValue({ appId: 'app-nueva' });
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/nuevo' });
    partnerSubscriptions.subscribeToEvents.mockResolvedValue({ status: 'success' });
    partnerSubscriptions.getSubscriptions.mockResolvedValue([]);
    standardTemplateService.ensureStandardTemplatesForChannel.mockResolvedValue({ created: [], catalog: [] });

    canalViejo = await WhatsAppChannel.create({
      tenantId: tenant._id, businessId: tenant._id, connectionType: 'DEDICATED', status: 'disconnected',
      onboardingStatus: 'completed', outboundApi: 'partner', phoneNumber: '+51900000202', phoneNumberId: '1000000000000601',
      wabaId: '1000000000000301', providerAppId: 'app-4f81', providerAccountId: `creaos${tenant._id}`,
    });
    await ChannelCredentials.create({
      channel: canalViejo._id, tenantId: tenant._id, provider: 'gupshup',
      apiKeys: [{ value: channelCrypto.encrypt('apikey-vieja', String(canalViejo._id)) }],
    });
    await ChannelOnboardingSession.create({
      tenantId: tenant._id, status: 'completed', channel: canalViejo._id,
      meta: { wabaId: '1000000000000301', phoneNumberId: '1000000000000601', phoneNumber: '+51900000202' },
      gupshup: { appId: 'app-4f81', appName: `creaos${tenant._id}`, webhookReference: 'gupshup:account-subscribed' },
    });
  });

  // Sesión pendiente de Nutriva, atada a la app Live del número anterior.
  const sesionNutriva = (overrides = {}) => ChannelOnboardingSession.create({
    tenantId: tenant._id,
    status: 'gupshup_registering',
    meta: {
      wabaId: '1000000000000101', phoneNumberId: '1000000000000501', phoneNumber: '+51900000101',
      accessTokenCipher: { ciphertext: 'cifrado', iv: 'iv', authTag: 'tag', keyVersion: 1 },
    },
    gupshup: {
      appId: 'app-4f81',
      webhookReference: 'gupshup:account-subscribed',
      messagesWebhookReference: 'gupshup:messages-subscribed',
      embedSignupUrl: 'https://embed.gupshup.io/viejo',
      embedSignupUrlGeneratedAt: new Date(),
    },
    expiresAt: new Date(Date.now() + DIA_MS),
    ...overrides,
  });

  const completarGupshup = async (sesion, tenantId = tenant._id) => {
    const res = mockRes();
    const next = jest.fn();
    await completeGupshupEmbeddedSignup({ businessId: tenantId, user: requester, body: { sessionId: String(sesion._id) } }, res, next);
    return { res, next };
  };

  describe('A/B. complete-gupshup nunca reutiliza la app Live de otro número', () => {
    test('sesión atada a la app Live del número anterior: crea una app independiente y la app vieja NO recibe ninguna llamada', async () => {
      const sesion = await sesionNutriva();

      const { res, next } = await completarGupshup(sesion);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const nombreEsperado = nombreAppUnico(tenant._id, sesion._id);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(partnerApps.createApp).toHaveBeenCalledWith({ name: nombreEsperado }, 'partner-token');
      expect(partnerApps.setContactDetails).toHaveBeenCalledWith('app-nueva', expect.objectContaining({ contactNumber: '+51900000101' }), 'partner-token');
      // Link pedido sobre la app NUEVA, sin tener que "regenerar" el de una app vieja.
      expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledTimes(1);
      expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledWith('app-nueva', { user: 'nutriva@creaos.test', lang: 'es' }, 'partner-token');
      // Suscripciones (ACCOUNT + mensajería) sobre la app nueva, con el webhook de onboarding de ESA app.
      expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledTimes(2);
      expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledWith(
        'app-nueva', 'apikey-de-la-app',
        expect.objectContaining({ url: 'https://backend.creaos.test/api/v1/webhooks/gupshup/onboarding/app-nueva', modes: ['ACCOUNT'] })
      );

      // La app Live anterior no fue consultada, suscripta, modificada ni nada.
      expect(appIdsTocados().has('app-4f81')).toBe(false);
      expect([...appIdsTocados()]).toEqual(['app-nueva']);

      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.gupshup.appId).toBe('app-nueva');
      expect(r.gupshup.appName).toBe(nombreEsperado);
      expect(r.gupshup.embedSignupUrl).toBe('https://embed.gupshup.io/nuevo');
      expect(r.status).toBe('gupshup_registering');
      expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * DIA_MS); // ya no depende de la ventana de 30 min
      // Autorización de Meta intacta.
      expect(r.meta.wabaId).toBe('1000000000000101');
      expect(r.meta.phoneNumberId).toBe('1000000000000501');
      expect(r.meta.accessTokenCipher.ciphertext).toBe('cifrado');

      // Conexión anterior preservada tal cual.
      const canal = await WhatsAppChannel.findById(canalViejo._id);
      expect(canal.status).toBe('disconnected');
      expect(canal.providerAppId).toBe('app-4f81');
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
    });

    test('un retry de la MISMA sesión reutiliza su app (ya es suya y segura): no crea otra ni vuelve a suscribir', async () => {
      const sesion = await sesionNutriva();
      await completarGupshup(sesion);
      partnerApps.createApp.mockClear();
      partnerSubscriptions.subscribeToEvents.mockClear();

      const { res, next } = await completarGupshup(sesion);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(partnerApps.createApp).not.toHaveBeenCalled();
      expect(partnerSubscriptions.subscribeToEvents).not.toHaveBeenCalled();
      expect((await ChannelOnboardingSession.findById(sesion._id)).gupshup.appId).toBe('app-nueva');
    });
  });

  describe('E. recuperación de la sesión pendiente, sin duplicaciones ni otra WABA', () => {
    test('REPRODUCE LA TRAMPA: con expiresAt vencido, la próxima lectura marca la sesión "expired" (irrecuperable por /complete-gupshup)', async () => {
      const sesion = await sesionNutriva({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) });

      const { res } = await completarGupshup(sesion);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].errors).toMatchObject({ code: 'INVALID_SESSION_STATE', currentState: 'expired' });
      expect(partnerApps.createApp).not.toHaveBeenCalled();
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('expired');
    });

    test('flujo de recuperación completo: recover → complete-gupshup → complete-gupshup — UNA sola app creada, mismo sessionId, misma WABA de Meta', async () => {
      const sesion = await sesionNutriva({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) });
      const sesionesAntes = await ChannelOnboardingSession.countDocuments({});

      await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });
      const primera = await completarGupshup(sesion);
      const segunda = await completarGupshup(sesion);

      expect(primera.res.status).toHaveBeenCalledWith(200);
      expect(segunda.res.status).toHaveBeenCalledWith(200);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1); // nada de apps duplicadas
      expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledTimes(2); // ACCOUNT + mensajería, una vez cada una
      expect(appIdsTocados().has('app-4f81')).toBe(false);
      expect(await ChannelOnboardingSession.countDocuments({})).toBe(sesionesAntes); // ninguna sesión nueva
      expect(await WhatsAppChannel.countDocuments({})).toBe(1); // ningún canal nuevo hasta que Gupshup confirme

      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r._id.toString()).toBe(sesion._id.toString());
      expect(r.meta.wabaId).toBe('1000000000000101'); // la WABA ya creada en Meta; no se pide otra
      expect(r.gupshup.appId).toBe('app-nueva');
      expect(r.gupshup.embedSignupUrl).toBe('https://embed.gupshup.io/nuevo');
    });

    test('tras recuperar y registrar la app nueva, la conciliación completa el canal CORRECTO (+51900000101) cuando Gupshup lo confirma', async () => {
      const sesion = await sesionNutriva({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) });
      await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });
      await completarGupshup(sesion);
      partnerApps.getWabaInfo.mockResolvedValue({
        phone: '51900000101', phoneId: 'pnid-definitivo-nutriva', wabaId: 'waba-definitiva', wabaName: 'Te Quiero GROUP SAC', accountStatus: 'ACTIVE',
      });

      const res = mockRes();
      const next = jest.fn();
      await reconcileEmbeddedSignup({ businessId: tenant._id, body: { sessionId: String(sesion._id) } }, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].data.outcome).toBe('completed');
      const canales = await WhatsAppChannel.find({ tenantId: tenant._id }).sort({ createdAt: 1 });
      expect(canales).toHaveLength(2);
      expect(canales[0]._id.toString()).toBe(canalViejo._id.toString());
      expect(canales[0].status).toBe('disconnected'); // el número anterior NO se reactiva
      expect(canales[1].phoneNumber).toBe('+51900000101');
      expect(canales[1].status).toBe('active');
      expect(canales[1].providerAppId).toBe('app-nueva');
      expect(canales[1].providerAccountId).toBe(nombreAppUnico(tenant._id, sesion._id));
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalledWith('app-4f81', expect.anything());
    });
  });

  describe('/callback — businessId de Meta opcional y ventana de la fase Gupshup', () => {
    async function sesionMetaAuthorized() {
      const s = await ChannelOnboardingSession.create({ tenantId: tenant._id });
      s.meta.accessTokenCipher = channelCrypto.encrypt('token-de-meta', `onboarding:${s._id}`);
      s.status = 'meta_authorized';
      await s.save();
      return s;
    }

    test('con businessId numérico válido: lo conserva; la ventana pasa de 30 min a 5 días', async () => {
      const s = await sesionMetaAuthorized();
      metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: '+51900000101', verifiedName: 'Nutriva' });

      const res = mockRes();
      await callbackEmbeddedSignup(
        { businessId: tenant._id, body: { sessionId: String(s._id), wabaId: '1000000000000101', phoneNumberId: '1000000000000501', businessId: '1000000000000201' } },
        res, jest.fn()
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const r = await ChannelOnboardingSession.findById(s._id);
      expect(r.meta.metaBusinessId).toBe('1000000000000201');
      expect(r.meta.wabaId).toBe('1000000000000101');
      expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * DIA_MS);
    });

    test('sin businessId, o con uno inválido: el onboarding sigue igual y metaBusinessId queda null (nunca bloquea)', async () => {
      for (const businessId of [undefined, 'no-numerico', 12345, '']) {
        const s = await sesionMetaAuthorized();
        metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: '+51900000101', verifiedName: 'Nutriva' });
        const res = mockRes();

        await callbackEmbeddedSignup(
          { businessId: tenant._id, body: { sessionId: String(s._id), wabaId: 'w', phoneNumberId: 'p', businessId } },
          res, jest.fn()
        );

        expect(res.status).toHaveBeenCalledWith(200);
        expect((await ChannelOnboardingSession.findById(s._id)).meta.metaBusinessId).toBeNull();
      }
    });
  });

  describe('POST /embedded-signup/reconcile', () => {
    const reconciliar = async (body, tenantId = tenant._id) => {
      const res = mockRes();
      const next = jest.fn();
      await reconcileEmbeddedSignup({ businessId: tenantId, body }, res, next);
      return { res, next };
    };

    test('sessionId ausente o con formato inválido: 400, sin tocar Gupshup', async () => {
      const a = await reconciliar({});
      const b = await reconciliar({ sessionId: 'esto-no-es-un-objectid' });
      expect(a.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(b.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('gupshup_link con mismatch acepta el número confirmado, reutiliza la misma app y completa por reconcile', async () => {
      const sesion = await ChannelOnboardingSession.create({
        tenantId: tenant._id,
        mode: 'gupshup_link',
        declaredPhone: '+51999999999',
        status: 'gupshup_registering',
        meta: { wabaId: null, phoneNumberId: null, phoneNumber: null, accessTokenCipher: null },
        gupshup: {
          appId: 'app-existente-mismatch',
          appName: 'creaosappactual',
          webhookReference: 'gupshup:account-subscribed',
          messagesWebhookReference: 'gupshup:messages-subscribed',
          embedSignupUrl: 'https://embed.gupshup.io/existente',
          embedSignupUrlGeneratedAt: new Date(),
        },
        reconcile: { stoppedAt: new Date(), stoppedReason: 'mismatch', lastOutcome: 'mismatch' },
        expiresAt: new Date(Date.now() + DIA_MS),
      });
      partnerApps.getWabaInfo.mockResolvedValue({
        phone: '51900000101', phoneId: 'pnid-recuperado', wabaId: 'waba-recuperada', accountStatus: 'ACTIVE',
      });

      const { res, next } = await reconciliar({ sessionId: String(sesion._id), phoneNumber: '+51 900 000 101' });

      expect(next).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].data.outcome).toBe('completed');
      expect(partnerApps.getAppAccessToken).toHaveBeenCalledWith('app-existente-mismatch', 'partner-token');
      expect(partnerApps.createApp).not.toHaveBeenCalled();
      const actual = await ChannelOnboardingSession.findById(sesion._id);
      expect(actual.declaredPhone).toBe('+51900000101');
      expect(actual.status).toBe('completed');
      expect((await WhatsAppChannel.findOne({ phoneNumber: '+51900000101' })).tenantId.toString()).toBe(tenant._id.toString());
    });

    test('número corregido inválido: 400 antes de consultar Gupshup o tocar la sesión', async () => {
      const sesion = await sesionNutriva();

      const { next } = await reconciliar({ sessionId: String(sesion._id), phoneNumber: '991046854' });

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
      expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('gupshup_registering');
    });

    test('sesión de OTRO tenant o inexistente: 404 y nada se consulta', async () => {
      const ajena = await ChannelOnboardingSession.create({
        tenantId: otroTenant._id, status: 'gupshup_registering',
        meta: { phoneNumber: '+51911111111' }, gupshup: { appId: 'app-ajena', embedSignupUrlGeneratedAt: new Date() },
      });
      const { next } = await reconciliar({ sessionId: String(ajena._id) });
      const { next: next2 } = await reconciliar({ sessionId: String(new mongoose.Types.ObjectId()) });

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(next2).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalled();
    });

    test('app todavía no Live: 200 con outcome "pending" — el HTTP 200 NO significa canal conectado', async () => {
      const sesion = await sesionNutriva({ gupshup: { appId: 'app-nueva', embedSignupUrlGeneratedAt: new Date() } });

      const { res, next } = await reconciliar({ sessionId: String(sesion._id) });

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.outcome).toBe('pending');
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id })).toBe(1); // solo el anterior
    });

    test('la respuesta nunca expone apikeys, tokens ni datos cifrados', async () => {
      const sesion = await sesionNutriva({ gupshup: { appId: 'app-nueva', embedSignupUrlGeneratedAt: new Date() } });
      partnerApps.getWabaInfo.mockResolvedValue({ phone: '51900000101', phoneId: 'pnid', wabaId: 'waba', accountStatus: 'ACTIVE' });

      const { res } = await reconciliar({ sessionId: String(sesion._id) });

      const serializado = JSON.stringify(res.json.mock.calls[0][0]);
      expect(res.json.mock.calls[0][0].data.outcome).toBe('completed');
      expect(serializado).not.toMatch(/apikey-de-la-app|partner-token|ciphertext|accessTokenCipher|cifrado/i);
    });
  });
});
