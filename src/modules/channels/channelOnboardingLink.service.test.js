// Test real (Jest, Mongo real en base propia, Gupshup/Meta mockeados enteros) del «modo enlace único» del onboarding de
// WhatsApp — channelOnboardingLink.service.js (informes 68/69). Nada pega contra Gupshup ni Meta. Cubre: interruptor
// apagado por defecto y lista de negocios, validación del número, camino feliz, idempotencia (repetida y simultánea),
// errores de Gupshup y recuperación, enlace vencido, conexión pendiente, activación exitosa por conciliación/barrido/
// webhook, número distinto (mismatch), aislamiento entre negocios y que el flujo clásico no cambia.
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');

jest.mock('./providers/meta/metaEmbeddedSignup.service');
jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');
jest.mock('./providers/gupshup/partner/partner.subscriptions');
jest.mock('./standardTemplate.service');

const mongoose = require('mongoose');
const env = require('../../config/env');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const standardTemplateService = require('./standardTemplate.service');
const { startLinkOnboarding, modoEnlaceHabilitado, normalizarTelefonoDeclarado } = require('./channelOnboardingLink.service');
const { reconcileOnboardingSession, handleGupshupAccountVerified } = require('./channelOnboardingCompletion.service');
const { sweepPendingOnboardingSessions } = require('./channelOnboardingReconcileSweep.service');
const { getCurrentOnboarding } = require('./channelOnboardingStatus.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_link';
const MIN = 60 * 1000;
const TEL = '+51900000301';
const USER = { email: 'duena@negocio.test', name: 'Dueña Prueba' };
const LINK = 'https://embed.gupshup.io/firmado-de-prueba';
const infoLive = (over = {}) => ({ phone: '51900000301', phoneId: 'pnid-301', wabaId: 'waba-301', accountStatus: 'ACTIVE', ...over });
const appNoLive = () => Object.assign(new Error('Gupshup Partner API rechazó la solicitud (getWabaInfo): App is not live.'), { statusCode: 400 });
const conectar = (tenant, over = {}) => startLinkOnboarding({ tenantId: tenant._id, user: USER, phoneNumber: TEL, ...over });

describe('channelOnboardingLink — modo enlace único', () => {
  let tenantA;
  let tenantB;
  let secuenciaApps;
  const envOriginal = { enabled: env.ONBOARDING_LINK_MODE_ENABLED, tenants: env.ONBOARDING_LINK_MODE_TENANTS, url: env.BACKEND_PUBLIC_URL, t1: env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN, t2: env.GUPSHUP_WEBHOOK_TOKEN };

  const limpiar = async () => {
    await ChannelOnboardingSession.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await ChannelCredentials.deleteMany({});
    await Business.deleteMany({});
  };

  beforeAll(async () => { await mongoose.connect(MONGO_URI); });
  afterAll(async () => {
    await limpiar();
    await mongoose.disconnect();
    Object.assign(env, { ONBOARDING_LINK_MODE_ENABLED: envOriginal.enabled, ONBOARDING_LINK_MODE_TENANTS: envOriginal.tenants, BACKEND_PUBLIC_URL: envOriginal.url, GUPSHUP_ONBOARDING_WEBHOOK_TOKEN: envOriginal.t1, GUPSHUP_WEBHOOK_TOKEN: envOriginal.t2 });
  });

  beforeEach(async () => {
    await limpiar();
    jest.clearAllMocks();
    Object.assign(env, { ONBOARDING_LINK_MODE_ENABLED: true, ONBOARDING_LINK_MODE_TENANTS: [], BACKEND_PUBLIC_URL: 'https://api.creaos.test', GUPSHUP_ONBOARDING_WEBHOOK_TOKEN: 'tok-onboarding', GUPSHUP_WEBHOOK_TOKEN: 'tok-mensajes' });
    tenantA = await Business.create({ name: 'Negocio A' });
    tenantB = await Business.create({ name: 'Negocio B' });
    secuenciaApps = 0;
    partnerAuth.getValidToken.mockResolvedValue('partner-token');
    partnerApps.createApp.mockImplementation(async () => ({ appId: `app-${++secuenciaApps}` }));
    partnerApps.getPartnerApps.mockResolvedValue([]);
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-app' });
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: LINK });
    partnerApps.getWabaInfo.mockRejectedValue(appNoLive());
    partnerSubscriptions.getSubscriptions.mockResolvedValue([]);
    partnerSubscriptions.subscribeToEvents.mockResolvedValue({});
    standardTemplateService.ensureStandardTemplatesForChannel.mockResolvedValue({ created: [], catalog: [] });
  });

  const sesiones = (tenant) => ChannelOnboardingSession.find({ tenantId: tenant._id }).lean();
  const sinLlamadasAGupshup = () => {
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
    expect(partnerApps.createApp).not.toHaveBeenCalled();
    expect(partnerApps.getEmbedSignupLink).not.toHaveBeenCalled();
    expect(partnerSubscriptions.subscribeToEvents).not.toHaveBeenCalled();
  };

  describe('interruptor: apagado por defecto y por negocio', () => {
    test('apagado: 404, no crea sesión y no llama a Gupshup', async () => {
      env.ONBOARDING_LINK_MODE_ENABLED = false;
      expect(modoEnlaceHabilitado(tenantA._id)).toBe(false);
      await expect(conectar(tenantA)).rejects.toMatchObject({ statusCode: 404 });
      expect(await sesiones(tenantA)).toHaveLength(0);
      sinLlamadasAGupshup();
    });

    test('el valor por defecto del entorno es apagado', () => {
      jest.isolateModules(() => {
        const previo = process.env.ONBOARDING_LINK_MODE_ENABLED;
        delete process.env.ONBOARDING_LINK_MODE_ENABLED;
        expect(require('../../config/env').ONBOARDING_LINK_MODE_ENABLED).toBe(false);
        if (previo !== undefined) process.env.ONBOARDING_LINK_MODE_ENABLED = previo;
      });
    });

    test('con lista de negocios: solo los de la lista; el resto 404 sin tocar nada', async () => {
      env.ONBOARDING_LINK_MODE_TENANTS = [String(tenantA._id)];
      expect(modoEnlaceHabilitado(tenantA._id)).toBe(true);
      expect(modoEnlaceHabilitado(tenantB._id)).toBe(false);
      await expect(conectar(tenantB)).rejects.toMatchObject({ statusCode: 404 });
      expect(await sesiones(tenantB)).toHaveLength(0);
      sinLlamadasAGupshup();
      await expect(conectar(tenantA)).resolves.toMatchObject({ embedSignupUrl: LINK });
    });
  });

  describe('número declarado', () => {
    test.each([
      ['sin código de país', '900000301'],
      ['con letras', '+51abc000301'],
      ['demasiado corto', '+5190'],
      ['vacío', '   '],
    ])('rechaza el número %s (400) sin llamar a Gupshup', async (_, valor) => {
      await expect(conectar(tenantA, { phoneNumber: valor })).rejects.toMatchObject({ statusCode: 400 });
      expect(await sesiones(tenantA)).toHaveLength(0);
      sinLlamadasAGupshup();
    });

    test('acepta espacios, guiones y paréntesis y guarda E.164', () => {
      expect(normalizarTelefonoDeclarado(' +51 (900) 000-301 ')).toBe('+51900000301');
    });

    test('un número ya conectado y activo en el mismo negocio: 409, nada nuevo', async () => {
      await WhatsAppChannel.create({ tenantId: tenantA._id, businessId: tenantA._id, connectionType: 'DEDICATED', status: 'active', phoneNumber: TEL, phoneNumberId: 'pn-x', wabaId: 'w-x', providerAppId: 'app-previa', providerAccountId: 'n', outboundApi: 'partner' });
      await expect(conectar(tenantA)).rejects.toMatchObject({ statusCode: 409 });
      expect(await sesiones(tenantA)).toHaveLength(0);
      sinLlamadasAGupshup();
    });

    test('un número que ya es de OTRO negocio: 409 genérico (no revela de quién) y nada se crea', async () => {
      await WhatsAppChannel.create({ tenantId: tenantB._id, businessId: tenantB._id, connectionType: 'DEDICATED', status: 'active', phoneNumber: TEL, phoneNumberId: 'pn-b', wabaId: 'w-b', providerAppId: 'app-b', providerAccountId: 'n', outboundApi: 'partner' });
      const error = await conectar(tenantA).catch((e) => e);
      expect(error.statusCode).toBe(409);
      expect(error.message).not.toMatch(/Negocio B|app-b|w-b/);
      expect(await sesiones(tenantA)).toHaveLength(0);
      sinLlamadasAGupshup();
    });
  });

  describe('camino feliz: una app, callbacks y un único enlace', () => {
    test('crea la sesión en modo enlace, la app, el contacto con el número declarado, las 2 suscripciones y el enlace', async () => {
      const r = await conectar(tenantA, { displayName: 'Línea ventas' });

      expect(r).toMatchObject({ embedSignupUrl: LINK, inProgress: false, created: true });
      expect(r.onboarding).toMatchObject({ phase: 'awaiting_gupshup', nextAction: 'open_link', mode: 'gupshup_link', phoneNumber: TEL, embedSignupUrl: LINK });

      const [sesion] = await sesiones(tenantA);
      expect(sesion).toMatchObject({ mode: 'gupshup_link', declaredPhone: TEL, status: 'gupshup_registering', displayName: 'Línea ventas', startLeaseUntil: null });
      expect(sesion.meta.wabaId).toBeNull();
      expect(sesion.meta.accessTokenCipher).toBeNull();
      expect(sesion.gupshup).toMatchObject({ appId: 'app-1', webhookReference: 'gupshup:account-subscribed', messagesWebhookReference: 'gupshup:messages-subscribed', embedSignupUrl: LINK });
      expect(sesion.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 24 * 60 * MIN);

      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(partnerApps.setContactDetails).toHaveBeenCalledWith('app-1', { contactEmail: USER.email, contactName: USER.name, contactNumber: TEL }, 'partner-token');
      expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledTimes(2);
      expect(partnerSubscriptions.subscribeToEvents.mock.calls.map((c) => c[2].modes[0]).sort()).toEqual(['ACCOUNT', 'ALL']);
      expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledTimes(1);
      // La respuesta nunca incluye credenciales.
      expect(JSON.stringify(r)).not.toMatch(/partner-token|apikey-app|tok-onboarding|tok-mensajes/);
    });

    test('el flujo no usa Bizgate, Universal Tokens, tpp/app ni vinculación por App ID + API key', async () => {
      await conectar(tenantA);
      const usadas = Object.entries(partnerApps).filter(([, f]) => f && f.mock && f.mock.calls.length).map(([nombre]) => nombre).sort();
      expect(usadas).toEqual(['createApp', 'getAppAccessToken', 'getEmbedSignupLink', 'setContactDetails']);
    });
  });

  describe('idempotencia: sin sesiones, apps ni enlaces duplicados', () => {
    test('repetir la solicitud (clic doble, recarga) devuelve la misma sesión y no vuelve a llamar a Gupshup', async () => {
      const uno = await conectar(tenantA);
      const dos = await conectar(tenantA);
      const tres = await conectar(tenantA, { phoneNumber: '+51 900 000 301' }); // mismo número, otro formato

      expect(dos.sessionId).toBe(uno.sessionId);
      expect(tres.sessionId).toBe(uno.sessionId);
      expect(dos.created).toBe(false);
      expect(await sesiones(tenantA)).toHaveLength(1);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledTimes(1);
      expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledTimes(2);
      expect(partnerApps.setContactDetails).toHaveBeenCalledTimes(1);
    });

    test('solicitudes SIMULTÁNEAS: una sola sesión, una app, un enlace', async () => {
      // Gupshup lento para que las solicitudes realmente se solapen.
      partnerApps.createApp.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 60)); return { appId: `app-${++secuenciaApps}` }; });
      const respuestas = await Promise.all(Array.from({ length: 6 }, () => conectar(tenantA)));

      expect(new Set(respuestas.map((r) => r.sessionId)).size).toBe(1);
      expect(await sesiones(tenantA).then((s) => s.filter((x) => x.status === 'gupshup_registering'))).toHaveLength(1);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledTimes(1);
      expect(respuestas.filter((r) => !r.inProgress && r.embedSignupUrl).length).toBeGreaterThanOrEqual(1);
      const final = await conectar(tenantA);
      expect(final).toMatchObject({ embedSignupUrl: LINK, inProgress: false });
    });

    test('20 solicitudes simultáneas en dos tandas: nunca más de una sesión viva ni una segunda app', async () => {
      partnerApps.createApp.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 30)); return { appId: `app-${++secuenciaApps}` }; });
      for (let tanda = 0; tanda < 2; tanda += 1) {
        await Promise.all(Array.from({ length: 10 }, () => conectar(tenantA)));
      }
      expect((await sesiones(tenantA)).filter((x) => x.status === 'gupshup_registering')).toHaveLength(1);
      expect((await sesiones(tenantA))).toHaveLength(1);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
    });

    test('tras vencer la sesión anterior, volver a conectar el mismo número abre una sesión nueva y reutiliza la app segura', async () => {
      const uno = await conectar(tenantA);
      await ChannelOnboardingSession.updateOne({ _id: uno.sessionId }, { $set: { status: 'expired' } });
      const dos = await conectar(tenantA);
      expect(dos.sessionId).not.toBe(uno.sessionId);
      expect(await sesiones(tenantA)).toHaveLength(2);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1); // la app sin número del intento anterior se reutiliza
      expect((await sesiones(tenantA)).map((x) => x.gupshup.appId)).toEqual(['app-1', 'app-1']);
    });

    test('dos números distintos del mismo negocio son dos conexiones independientes (cada una con su app)', async () => {
      const a = await conectar(tenantA);
      const b = await conectar(tenantA, { phoneNumber: '+51900000302' });
      expect(b.sessionId).not.toBe(a.sessionId);
      const apps = (await sesiones(tenantA)).map((s) => s.gupshup.appId);
      expect(new Set(apps).size).toBe(2);
    });

    test('si la app ya existe en Gupshup (409) se resuelve por nombre y no se duplica', async () => {
      partnerApps.createApp.mockRejectedValueOnce(Object.assign(new Error('Bot Already Exists'), { statusCode: 409 }));
      partnerApps.getPartnerApps.mockImplementation(async () => [{ id: 'app-existente', name: `creaos${tenantA._id}` }]);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());
      const r = await conectar(tenantA);
      expect(r.embedSignupUrl).toBe(LINK);
      expect((await sesiones(tenantA))[0].gupshup.appId).toBe('app-existente');
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
    });
  });

  describe('errores de Gupshup y recuperación', () => {
    test('falla al crear la app: error reintentable, sesión failed (paso gupshup_registration), arrendamiento liberado; el reintento completa sin duplicar la sesión', async () => {
      partnerApps.createApp.mockRejectedValueOnce(Object.assign(new Error('Gupshup Partner API: error interno del proveedor'), { statusCode: 502 }));
      await expect(conectar(tenantA)).rejects.toMatchObject({ statusCode: 502 });

      let [sesion] = await sesiones(tenantA);
      expect(sesion).toMatchObject({ status: 'failed', startLeaseUntil: null });
      expect(sesion.error.step).toBe('gupshup_registration');
      expect(sesion.gupshup.appId).toBeNull();

      const r = await conectar(tenantA);
      expect(r.embedSignupUrl).toBe(LINK);
      const todas = await sesiones(tenantA);
      expect(todas).toHaveLength(1);
      expect(todas[0]).toMatchObject({ status: 'gupshup_registering', error: { step: null, message: null } });
      expect(partnerApps.createApp).toHaveBeenCalledTimes(2); // 1 fallida + 1 exitosa: nunca dos apps vivas
    });

    test('falla DESPUÉS de crear la app (suscripción): la app queda guardada y el reintento no crea otra', async () => {
      partnerSubscriptions.subscribeToEvents.mockRejectedValueOnce(Object.assign(new Error('400 Duplicate component tag.'), { statusCode: 400 }));
      await expect(conectar(tenantA)).rejects.toMatchObject({ statusCode: 400 });
      expect((await sesiones(tenantA))[0].gupshup.appId).toBe('app-1');

      const r = await conectar(tenantA);
      expect(r.embedSignupUrl).toBe(LINK);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect((await sesiones(tenantA))[0].gupshup.appId).toBe('app-1');
    });

    test('Gupshup rate limit (429) al generar el enlace: se informa, la sesión queda recuperable y el reintento funciona', async () => {
      partnerApps.getEmbedSignupLink.mockRejectedValueOnce(Object.assign(new Error('Gupshup Partner API: rate limit excedido'), { statusCode: 429 }));
      await expect(conectar(tenantA)).rejects.toMatchObject({ statusCode: 429 });
      const r = await conectar(tenantA);
      expect(r.embedSignupUrl).toBe(LINK);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
    });

    test('enlace vencido: una única regeneración explícita', async () => {
      partnerApps.getEmbedSignupLink
        .mockRejectedValueOnce(new Error('Link has expired, please regenerate link'))
        .mockResolvedValueOnce({ link: 'https://embed.gupshup.io/regenerado' });
      const r = await conectar(tenantA);
      expect(r.embedSignupUrl).toBe('https://embed.gupshup.io/regenerado');
      expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledTimes(2);
      expect(partnerApps.getEmbedSignupLink.mock.calls[1][1]).toMatchObject({ regenerate: true });
    });

    test('un enlace guardado casi vencido se regenera al volver a pulsar, sin crear otra app', async () => {
      await conectar(tenantA);
      await ChannelOnboardingSession.updateOne({ tenantId: tenantA._id }, { $set: { 'gupshup.embedSignupUrlGeneratedAt': new Date(Date.now() - 4.99 * 24 * 60 * MIN) } });
      partnerApps.getEmbedSignupLink.mockResolvedValueOnce({ link: 'https://embed.gupshup.io/nuevo' });
      const r = await conectar(tenantA);
      expect(r.embedSignupUrl).toBe('https://embed.gupshup.io/nuevo');
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(partnerApps.getEmbedSignupLink.mock.calls[1][1]).toMatchObject({ regenerate: true });
    });

    test('una sesión fallida en otro paso (creación del canal) no se toca: la resuelve el barrido', async () => {
      await conectar(tenantA);
      await ChannelOnboardingSession.updateOne({ tenantId: tenantA._id }, { $set: { status: 'failed', 'error.step': 'channel_creation', 'error.message': 'x' } });
      jest.clearAllMocks();
      const r = await conectar(tenantA);
      expect(r.inProgress).toBe(false);
      sinLlamadasAGupshup();
    });
  });

  describe('conexión pendiente y activación', () => {
    // Deja el enlace «generado hace 10 min»: ya pasó la ventana que le da prioridad al webhook.
    const envejecerEnlace = (tenant) => ChannelOnboardingSession.updateOne({ tenantId: tenant._id }, { $set: { 'gupshup.embedSignupUrlGeneratedAt': new Date(Date.now() - 10 * MIN) } });

    test('mientras el cliente no completa el enlace: pendiente, sin canal, y el estado pide abrir el enlace', async () => {
      const { sessionId } = await conectar(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());

      expect(await reconcileOnboardingSession({ sessionId, tenantId: tenantA._id })).toMatchObject({ outcome: 'pending' });
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(0);
      expect(await getCurrentOnboarding({ tenantId: tenantA._id })).toMatchObject({ phase: 'awaiting_gupshup', nextAction: 'open_link', mode: 'gupshup_link', phoneNumber: TEL });
    });

    test('app Live con el MISMO número: la conciliación activa un único canal DEDICATED con credenciales, sin datos de Meta', async () => {
      const { sessionId } = await conectar(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue(infoLive());

      const r = await reconcileOnboardingSession({ sessionId, tenantId: tenantA._id });

      expect(r.outcome).toBe('completed');
      const canales = await WhatsAppChannel.find({ tenantId: tenantA._id }).lean();
      expect(canales).toHaveLength(1);
      expect(canales[0]).toMatchObject({ connectionType: 'DEDICATED', status: 'active', outboundApi: 'partner', phoneNumber: TEL, providerAppId: 'app-1', wabaId: 'waba-301', phoneNumberId: 'pnid-301' });
      expect(await ChannelCredentials.countDocuments({ tenantId: tenantA._id })).toBe(1);
      expect(await ChannelOnboardingSession.findById(sessionId).lean()).toMatchObject({ status: 'completed', completedVia: 'reconcile' });
      expect(await getCurrentOnboarding({ tenantId: tenantA._id })).toBeNull();

      // Repetir la conciliación («Ya terminé» dos veces) no crea nada más.
      expect(await reconcileOnboardingSession({ sessionId, tenantId: tenantA._id })).toMatchObject({ outcome: 'already_completed' });
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(1);
    });

    test('app Live pero con OTRO número que el declarado: mismatch, no se activa nada', async () => {
      const { sessionId } = await conectar(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ phone: '51999999999' }));

      const r = await reconcileOnboardingSession({ sessionId, tenantId: tenantA._id });

      expect(r).toMatchObject({ outcome: 'mismatch', expected: TEL, found: '+51999999999' });
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      expect(await ChannelOnboardingSession.findById(sessionId).lean()).toMatchObject({ status: 'gupshup_registering' });
    });

    test('WABA o número que ya pertenecen a un canal de OTRO negocio: identity_conflict, no se activa', async () => {
      const { sessionId } = await conectar(tenantA);
      await WhatsAppChannel.create({ tenantId: tenantB._id, businessId: tenantB._id, connectionType: 'DEDICATED', status: 'active', phoneNumber: '+51988888888', phoneNumberId: 'pnid-301', wabaId: 'waba-301', providerAppId: 'app-b', providerAccountId: 'n', outboundApi: 'partner' });
      partnerApps.getWabaInfo.mockResolvedValue(infoLive());

      expect(await reconcileOnboardingSession({ sessionId, tenantId: tenantA._id })).toMatchObject({ outcome: 'identity_conflict' });
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(0);
    });

    test('el barrido automático toma la sesión del modo enlace: pendiente y luego activa', async () => {
      const { sessionId } = await conectar(tenantA);
      await envejecerEnlace(tenantA);
      partnerApps.getWabaInfo.mockRejectedValue(appNoLive());

      expect(await sweepPendingOnboardingSessions()).toMatchObject({ revisadas: 1, pendientes: 1, completadas: 0 });
      let s = await ChannelOnboardingSession.findById(sessionId).lean();
      expect(s.reconcile).toMatchObject({ attempts: 1, lastOutcome: 'pending' });

      await ChannelOnboardingSession.updateOne({ _id: sessionId }, { $set: { 'reconcile.nextAttemptAt': null } });
      partnerApps.getWabaInfo.mockResolvedValue(infoLive());
      expect(await sweepPendingOnboardingSessions()).toMatchObject({ revisadas: 1, completadas: 1 });
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id, status: 'active' })).toBe(1);
    });

    test('el webhook ACCOUNT_VERIFIED activa la sesión del modo enlace (y una entrega repetida no duplica)', async () => {
      await conectar(tenantA);
      partnerApps.getWabaInfo.mockResolvedValue(infoLive());

      await handleGupshupAccountVerified('app-1');
      await handleGupshupAccountVerified('app-1');

      expect(await WhatsAppChannel.countDocuments({ tenantId: tenantA._id })).toBe(1);
      expect((await sesiones(tenantA))[0]).toMatchObject({ status: 'completed', completedVia: 'webhook' });
    });
  });

  describe('aislamiento entre negocios', () => {
    test('el mismo número en dos negocios genera dos sesiones y dos apps separadas; ninguna ve la del otro', async () => {
      const a = await conectar(tenantA);
      const b = await conectar(tenantB);

      expect(b.sessionId).not.toBe(a.sessionId);
      const [sa] = await sesiones(tenantA);
      const [sb] = await sesiones(tenantB);
      expect(sa.gupshup.appId).not.toBe(sb.gupshup.appId);
      expect(await getCurrentOnboarding({ tenantId: tenantA._id })).toMatchObject({ sessionId: a.sessionId });
      expect(await getCurrentOnboarding({ tenantId: tenantB._id })).toMatchObject({ sessionId: b.sessionId });
      // Un negocio no puede conciliar la sesión del otro.
      expect(await reconcileOnboardingSession({ sessionId: a.sessionId, tenantId: tenantB._id })).toMatchObject({ outcome: 'not_found' });
    });

    test('una app de otro negocio nunca se reutiliza', async () => {
      await conectar(tenantA);
      const b = await conectar(tenantB);
      expect((await sesiones(tenantB))[0].gupshup.appId).not.toBe((await sesiones(tenantA))[0].gupshup.appId);
      expect(b.embedSignupUrl).toBe(LINK);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(2);
    });
  });

  describe('el flujo clásico no cambia', () => {
    test('una sesión clásica (sin mode ni declaredPhone) sigue conciliando contra el número de Meta', async () => {
      const sesion = await ChannelOnboardingSession.create({
        tenantId: tenantA._id, status: 'gupshup_registering',
        meta: { wabaId: 'w-1', phoneNumberId: 'p-1', phoneNumber: TEL },
        gupshup: { appId: 'app-clasica', appName: 'creaosclasica', webhookReference: 'x', messagesWebhookReference: 'y', embedSignupUrl: LINK, embedSignupUrlGeneratedAt: new Date(Date.now() - 10 * MIN) },
        expiresAt: new Date(Date.now() + 4 * 24 * 60 * MIN),
      });
      partnerApps.getWabaInfo.mockResolvedValue(infoLive({ phone: '51977777777' }));
      expect(await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id })).toMatchObject({ outcome: 'mismatch', expected: TEL });
      partnerApps.getWabaInfo.mockResolvedValue(infoLive());
      expect((await reconcileOnboardingSession({ sessionId: sesion._id, tenantId: tenantA._id })).outcome).toBe('completed');
      expect(await getCurrentOnboarding({ tenantId: tenantB._id })).toBeNull();
    });

    test('el estado de una sesión clásica se informa como meta_then_link', async () => {
      await ChannelOnboardingSession.create({
        tenantId: tenantA._id, status: 'gupshup_registering',
        meta: { wabaId: 'w-1', phoneNumberId: 'p-1', phoneNumber: TEL, accessTokenCipher: { ciphertext: 'a', iv: 'b', authTag: 'c', keyVersion: 1 } },
        gupshup: { appId: 'app-clasica', embedSignupUrl: LINK, embedSignupUrlGeneratedAt: new Date() },
        expiresAt: new Date(Date.now() + 4 * 24 * 60 * MIN),
      });
      expect(await getCurrentOnboarding({ tenantId: tenantA._id })).toMatchObject({ phase: 'awaiting_gupshup', mode: 'meta_then_link' });
    });
  });
});
