// Test real (Jest, Mongo real en base propia, Gupshup mockeado entero) de
// channelOnboardingApp.service.js — incidente de Nutriva (14/oct/2026): una app de
// Gupshup Live con el número anterior NUNCA se reutiliza para un número nuevo, y
// cada conexión nueva queda en una app independiente. Nada pega contra Meta ni
// Gupshup reales.
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');

jest.mock('./providers/gupshup/partner/partner.apps');

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const {
  nombreAppGupshup,
  nombreAppUnico,
  telefonosCoinciden,
  evaluarAppLocal,
  desvincularApp,
  seleccionarOCrearApp,
} = require('./channelOnboardingApp.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_app';
const TELEFONO_VIEJO = '+51900000202';
const TELEFONO_NUEVO = '+51900000101';

const appNoLive = (appId) => Object.assign(
  new Error(`Gupshup Partner API rechazó la solicitud (getWabaInfo de app ${appId}): App is not live.`),
  { statusCode: 400 }
);

describe('channelOnboardingApp.service', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    tenantA = await Business.create({ name: 'Tenant A (Nutriva)' });
    tenantB = await Business.create({ name: 'Tenant B (otro cliente)' });
    jest.clearAllMocks();
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-de-prueba' });
    partnerApps.getWabaInfo.mockRejectedValue(appNoLive('x')); // por defecto: ninguna app está Live
  });

  const nuevaSesion = (tenant, overrides = {}) => ChannelOnboardingSession.create({
    tenantId: tenant._id,
    status: 'gupshup_registering',
    meta: { wabaId: '1000000000000101', phoneNumberId: '1000000000000501', phoneNumber: TELEFONO_NUEVO },
    ...overrides,
  });

  const canalAnterior = (tenant, overrides = {}) => WhatsAppChannel.create({
    tenantId: tenant._id,
    businessId: tenant._id,
    connectionType: 'DEDICATED',
    status: 'disconnected',
    onboardingStatus: 'completed',
    outboundApi: 'partner',
    phoneNumber: TELEFONO_VIEJO,
    phoneNumberId: `pnid-${tenant._id}`,
    wabaId: '1000000000000301',
    providerAppId: 'app-vieja-live',
    providerAccountId: nombreAppGupshup(tenant._id),
    ...overrides,
  });

  describe('helpers', () => {
    test('telefonosCoinciden(): compara por dígitos, ignora +, espacios y guiones; vacío nunca coincide', () => {
      expect(telefonosCoinciden('+51 900-000-101', '51900000101')).toBe(true);
      expect(telefonosCoinciden('+51900000101', '+51900000202')).toBe(false);
      expect(telefonosCoinciden(null, '51900000101')).toBe(false);
      expect(telefonosCoinciden('', '')).toBe(false);
    });

    test('nombres de app: alfanuméricos (sin guiones), el único por sesión nunca colisiona con el base ni entre sesiones', () => {
      const base = nombreAppGupshup(tenantA._id);
      const s1 = new mongoose.Types.ObjectId();
      const s2 = new mongoose.Types.ObjectId();
      expect(base).toBe(`creaos${tenantA._id}`);
      expect(nombreAppUnico(tenantA._id, s1)).not.toBe(base);
      expect(nombreAppUnico(tenantA._id, s1)).not.toBe(nombreAppUnico(tenantA._id, s2));
      expect(nombreAppUnico(tenantA._id, s1)).toMatch(/^[a-z0-9]+$/i);
    });
  });

  describe('A. app antigua Live: nunca se reutiliza para otro número', () => {
    test('canal anterior (otro número) ligado a la app + sesión previa con esa app: se crea una app NUEVA e independiente, la vieja no se toca', async () => {
      const canalViejo = await canalAnterior(tenantA);
      const sesionVieja = await nuevaSesion(tenantA, {
        status: 'completed', channel: canalViejo._id,
        meta: { wabaId: '1000000000000301', phoneNumberId: '1000000000000601', phoneNumber: TELEFONO_VIEJO },
        gupshup: { appId: 'app-vieja-live', appName: nombreAppGupshup(tenantA._id), webhookReference: 'gupshup:account-subscribed' },
      });
      const sesion = await nuevaSesion(tenantA);
      partnerApps.createApp.mockResolvedValue({ appId: 'app-nueva-independiente' });

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 'partner-token' });

      expect(res).toEqual({ appId: 'app-nueva-independiente', appName: nombreAppUnico(tenantA._id, sesion._id), origen: 'creada' });
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(partnerApps.createApp).toHaveBeenCalledWith({ name: nombreAppUnico(tenantA._id, sesion._id) }, 'partner-token');
      // La app vieja ni se consultó (descartada por el chequeo local, sin llamar a Gupshup).
      expect(partnerApps.getAppAccessToken).not.toHaveBeenCalledWith('app-vieja-live', expect.anything());
      expect(partnerApps.getWabaInfo).not.toHaveBeenCalledWith('app-vieja-live', expect.anything());

      const refrescada = await ChannelOnboardingSession.findById(sesion._id);
      expect(refrescada.gupshup.appId).toBe('app-nueva-independiente');
      expect(refrescada.gupshup.appName).toBe(nombreAppUnico(tenantA._id, sesion._id));

      // Preservación de lo anterior: canal y sesión viejos exactamente como estaban.
      const canalRefrescado = await WhatsAppChannel.findById(canalViejo._id);
      expect(canalRefrescado.status).toBe('disconnected');
      expect(canalRefrescado.providerAppId).toBe('app-vieja-live');
      expect(canalRefrescado.phoneNumber).toBe(TELEFONO_VIEJO);
      const sesionViejaRefrescada = await ChannelOnboardingSession.findById(sesionVieja._id);
      expect(sesionViejaRefrescada.gupshup.appId).toBe('app-vieja-live');
      expect(sesionViejaRefrescada.status).toBe('completed');
    });

    test('app previa SIN canal local pero Live en Gupshup con OTRO número (webhook que nunca llegó): descartada por waba/info, se crea una nueva', async () => {
      await nuevaSesion(tenantA, {
        status: 'failed', error: { step: 'gupshup_registration', message: 'x' },
        gupshup: { appId: 'app-live-sin-canal' },
      });
      const sesion = await nuevaSesion(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue({ phone: '51900000202', phoneId: 'p1', wabaId: 'w1', accountStatus: 'ACTIVE' });
      partnerApps.createApp.mockResolvedValue({ appId: 'app-nueva' });

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' });

      expect(partnerApps.getWabaInfo).toHaveBeenCalledWith('app-live-sin-canal', 'apikey-de-prueba');
      expect(res.appId).toBe('app-nueva');
      expect(res.origen).toBe('creada');
    });

    test('app previa en sesión EN CURSO de otro número (todavía no Live): tampoco se comparte', async () => {
      await nuevaSesion(tenantA, {
        meta: { wabaId: 'w-otro', phoneNumberId: 'p-otro', phoneNumber: TELEFONO_VIEJO },
        gupshup: { appId: 'app-en-uso-por-otra-sesion' },
      });
      const sesion = await nuevaSesion(tenantA);
      partnerApps.createApp.mockResolvedValue({ appId: 'app-propia' });

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' });

      expect(res.appId).toBe('app-propia');
      expect(partnerApps.getAppAccessToken).not.toHaveBeenCalledWith('app-en-uso-por-otra-sesion', expect.anything());
    });

    test('error al consultar Gupshup para validar una candidata: fail-closed — no reutiliza ni crea nada, propaga el error', async () => {
      await nuevaSesion(tenantA, { status: 'failed', error: { step: 'gupshup_registration', message: 'x' }, gupshup: { appId: 'app-dudosa' } });
      const sesion = await nuevaSesion(tenantA);
      const caido = Object.assign(new Error('Gupshup Partner API no respondió'), { statusCode: 504 });
      partnerApps.getWabaInfo.mockRejectedValue(caido);

      await expect(seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' })).rejects.toBe(caido);

      expect(partnerApps.createApp).not.toHaveBeenCalled();
      expect((await ChannelOnboardingSession.findById(sesion._id)).gupshup.appId).toBeNull();
    });

    test('evaluarAppLocal(): una app ligada a un canal del MISMO número sí es segura (reconexión del mismo número)', async () => {
      await canalAnterior(tenantA);
      const sesionMismoNumero = await nuevaSesion(tenantA, { meta: { wabaId: 'w', phoneNumberId: 'p', phoneNumber: TELEFONO_VIEJO } });

      const res = await evaluarAppLocal({ appId: 'app-vieja-live', session: sesionMismoNumero, tenantId: tenantA._id });

      expect(res).toEqual({ seguro: true });
    });
  });

  describe('B. número/WABA nuevo: asociación independiente', () => {
    test('tenant sin apps previas: crea la app con el nombre base determinístico (compatibilidad con el flujo original)', async () => {
      const sesion = await nuevaSesion(tenantA);
      partnerApps.createApp.mockResolvedValue({ appId: 'primera-app' });

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' });

      expect(partnerApps.createApp).toHaveBeenCalledWith({ name: nombreAppGupshup(tenantA._id) }, 't');
      expect(res).toEqual({ appId: 'primera-app', appName: nombreAppGupshup(tenantA._id), origen: 'creada' });
    });

    test('reintento del MISMO número con una app previa que no llegó a estar Live ("App is not live"): se reutiliza, sin crear otra', async () => {
      await nuevaSesion(tenantA, {
        status: 'failed', error: { step: 'gupshup_registration', message: 'x' },
        gupshup: { appId: 'app-sin-live', appName: 'creaosdelanterior' },
      });
      const sesion = await nuevaSesion(tenantA);

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' });

      expect(partnerApps.createApp).not.toHaveBeenCalled();
      expect(res).toEqual({ appId: 'app-sin-live', appName: 'creaosdelanterior', origen: 'reutilizada' });
    });

    test('app previa Live con el MISMO número que la sesión: se reutiliza (la conciliación la completará)', async () => {
      await nuevaSesion(tenantA, { status: 'failed', error: { step: 'gupshup_registration', message: 'x' }, gupshup: { appId: 'app-ya-live-correcta' } });
      const sesion = await nuevaSesion(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue({ phone: '51900000101', phoneId: 'p', wabaId: 'w', accountStatus: 'ACTIVE' });

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' });

      expect(res.appId).toBe('app-ya-live-correcta');
      expect(partnerApps.createApp).not.toHaveBeenCalled();
    });

    test('409 "Bot Already Exists" con el nombre base ocupado por una app Live con otro número: cae al nombre único por sesión', async () => {
      const sesion = await nuevaSesion(tenantA);
      const base = nombreAppGupshup(tenantA._id);
      const unico = nombreAppUnico(tenantA._id, sesion._id);
      const conflicto = Object.assign(new Error('Bot Already Exists'), { statusCode: 409 });
      partnerApps.createApp.mockImplementation(async ({ name }) => {
        if (name === base) throw conflicto;
        return { appId: 'app-con-nombre-unico' };
      });
      partnerApps.getPartnerApps.mockResolvedValue([{ id: 'app-base-externa', name: base }]);
      partnerApps.getWabaInfo.mockResolvedValue({ phone: '51900000202', phoneId: 'p', wabaId: 'w', accountStatus: 'ACTIVE' });

      const res = await seleccionarOCrearApp({ session: sesion, tenantId: tenantA._id, token: 't' });

      expect(partnerApps.createApp.mock.calls.map(([arg]) => arg.name)).toEqual([base, unico]);
      expect(res).toEqual({ appId: 'app-con-nombre-unico', appName: unico, origen: 'creada' });
    });

    test('dos sesiones del mismo tenant con números distintos terminan en apps DISTINTAS', async () => {
      partnerApps.createApp
        .mockResolvedValueOnce({ appId: 'app-numero-1' })
        .mockResolvedValueOnce({ appId: 'app-numero-2' });
      const s1 = await nuevaSesion(tenantA, { meta: { wabaId: 'w1', phoneNumberId: 'p1', phoneNumber: TELEFONO_VIEJO } });
      const r1 = await seleccionarOCrearApp({ session: s1, tenantId: tenantA._id, token: 't' });
      const s2 = await nuevaSesion(tenantA);
      const r2 = await seleccionarOCrearApp({ session: s2, tenantId: tenantA._id, token: 't' });

      expect(r1.appId).toBe('app-numero-1');
      expect(r2.appId).toBe('app-numero-2');
      expect(r2.appName).not.toBe(r1.appName);
    });
  });

  describe('aislamiento multi-tenant', () => {
    test('un tenant nunca evalúa ni reutiliza las apps de otro tenant', async () => {
      await nuevaSesion(tenantB, { status: 'failed', error: { step: 'gupshup_registration', message: 'x' }, gupshup: { appId: 'app-de-B' } });
      await canalAnterior(tenantB, { providerAppId: 'app-de-B' });
      const sesionA = await nuevaSesion(tenantA);
      partnerApps.createApp.mockResolvedValue({ appId: 'app-de-A' });

      const res = await seleccionarOCrearApp({ session: sesionA, tenantId: tenantA._id, token: 't' });

      expect(res.appId).toBe('app-de-A');
      expect(partnerApps.getAppAccessToken).not.toHaveBeenCalledWith('app-de-B', expect.anything());
      expect(partnerApps.createApp).toHaveBeenCalledWith({ name: nombreAppGupshup(tenantA._id) }, 't');
    });

    test('evaluarAppLocal(): un appId que figura en un canal o sesión de OTRO tenant es inseguro', async () => {
      await canalAnterior(tenantB, { providerAppId: 'app-compartida-por-error' });
      const sesionA = await nuevaSesion(tenantA);

      const res = await evaluarAppLocal({ appId: 'app-compartida-por-error', session: sesionA, tenantId: tenantA._id });

      expect(res).toEqual({ seguro: false, motivo: 'app_de_otro_tenant' });

      await WhatsAppChannel.deleteMany({});
      await nuevaSesion(tenantB, { gupshup: { appId: 'app-solo-en-sesion-de-B' } });
      const res2 = await evaluarAppLocal({ appId: 'app-solo-en-sesion-de-B', session: sesionA, tenantId: tenantA._id });
      expect(res2).toEqual({ seguro: false, motivo: 'app_de_otro_tenant' });
    });
  });

  describe('desvincularApp()', () => {
    test('limpia solo lo dependiente de la app y conserva sessionId, IDs de Meta y token de Meta cifrado', async () => {
      const sesion = await nuevaSesion(tenantA, {
        meta: {
          wabaId: '1000000000000101', phoneNumberId: '1000000000000501', phoneNumber: TELEFONO_NUEVO, metaBusinessId: '1000000000000201',
          accessTokenCipher: { ciphertext: 'c', iv: 'i', authTag: 'a', keyVersion: 1 },
        },
        gupshup: {
          appId: 'app-vieja', appName: 'creaosx', webhookReference: 'gupshup:account-subscribed',
          messagesWebhookReference: 'gupshup:messages-subscribed', embedSignupUrl: 'https://embed/x', embedSignupUrlGeneratedAt: new Date(),
        },
      });

      await desvincularApp(sesion);

      const r = await ChannelOnboardingSession.findById(sesion._id);
      expect(r.gupshup.appId).toBeNull();
      expect(r.gupshup.appName).toBeNull();
      expect(r.gupshup.webhookReference).toBeNull();
      expect(r.gupshup.messagesWebhookReference).toBeNull();
      expect(r.gupshup.embedSignupUrl).toBeNull();
      expect(r._id.toString()).toBe(sesion._id.toString());
      expect(r.meta.wabaId).toBe('1000000000000101');
      expect(r.meta.phoneNumberId).toBe('1000000000000501');
      expect(r.meta.metaBusinessId).toBe('1000000000000201');
      expect(r.meta.accessTokenCipher.ciphertext).toBe('c');
      expect(r.status).toBe('gupshup_registering');
    });
  });
});
