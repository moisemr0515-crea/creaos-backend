// Test real (Jest, commiteado) de channelOnboardingCompletion.service.js —
// PR-06 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md).
//
// Contra Mongo real (mismo criterio que el resto del módulo channels/), en
// una base propia de este archivo. partner.auth/partner.apps se mockean
// enteros — nunca pegan contra Gupshup real; ya tienen sus propios tests
// aislados (incluida la nueva getAppAccessToken()).
//
// CHANNEL_CREDENTIALS_KEY se genera ANTES de requerir config/env.js/
// channelCrypto.js (mismo motivo que channel.controller.test.js/
// partner.auth.test.js: dotenv.config() no pisa una key que ya existe en
// process.env).
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');

jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const channelCrypto = require('./channelCrypto');
const logger = require('../../utils/logger');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const { handleGupshupAccountVerified, isAccountVerifiedEvent } = require('./channelOnboardingCompletion.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_completion';

const ACCOUNT_VERIFIED_PAYLOAD = (gsAppId) => ({
  object: 'whatsapp_business_account',
  gs_app_id: gsAppId,
  entry: [{ id: 'x', time: 1, changes: [{ field: 'account-event', value: { payload: { status: 'ACCOUNT_VERIFIED' }, type: 'status-event' } }] }],
});

describe('channelOnboardingCompletion#isAccountVerifiedEvent()', () => {
  test('true: payload real de Go-Live (v3, account-event + ACCOUNT_VERIFIED)', () => {
    expect(isAccountVerifiedEvent(ACCOUNT_VERIFIED_PAYLOAD('gs-app-x'))).toBe(true);
  });

  test('false: mismo formato pero field "messages" (mensajería normal)', () => {
    expect(isAccountVerifiedEvent({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {} }] }] })).toBe(false);
  });

  test('false: account-event pero con otro status (no ACCOUNT_VERIFIED)', () => {
    expect(isAccountVerifiedEvent({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'account-event', value: { payload: { status: 'ACCOUNT_SUSPENDED' } } }] }],
    })).toBe(false);
  });

  test('false: object distinto de whatsapp_business_account', () => {
    expect(isAccountVerifiedEvent({ object: 'page', entry: [] })).toBe(false);
  });

  test('false: payload vacío/null/sin entry, nunca explota', () => {
    expect(isAccountVerifiedEvent(null)).toBe(false);
    expect(isAccountVerifiedEvent({})).toBe(false);
    expect(isAccountVerifiedEvent({ object: 'whatsapp_business_account' })).toBe(false);
  });
});

describe('channelOnboardingCompletion#handleGupshupAccountVerified()', () => {
  let business;

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
    business = await Business.create({ name: 'Negocio de prueba' });
    jest.clearAllMocks();
  });

  // Helper — sesión ya en 'gupshup_registering', con appId + phoneNumber ya
  // resueltos (equivalente a lo que deja completeGupshupEmbeddedSignup(), PR-05/06).
  function crearSesionListaParaWebhook(overrides = {}) {
    return ChannelOnboardingSession.create({
      tenantId: business._id,
      status: 'gupshup_registering',
      displayName: 'Línea de ventas',
      meta: {
        wabaId: 'waba-real',
        phoneNumberId: 'pnid-real',
        phoneNumber: '+16315555556',
        accessTokenCipher: channelCrypto.encrypt('token-de-meta-ya-sin-uso', 'onboarding:placeholder'),
      },
      gupshup: { appId: 'gs-app-real', webhookReference: 'gupshup:account-subscribed' },
      ...overrides,
    });
  }

  test('gsAppId sin ninguna sesión asociada: no-op, se loguea warning, no crea nada', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await handleGupshupAccountVerified('gs-app-huerfana');

    expect(warnSpy).toHaveBeenCalledWith(
      '[channelOnboardingCompletion] account-event sin ninguna ChannelOnboardingSession asociada',
      { gsAppId: 'gs-app-huerfana' }
    );
    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  test('sesión ya "completed" (redelivery del webhook): no-op idempotente, no crea un segundo canal', async () => {
    const channelId = new mongoose.Types.ObjectId();
    const session = await crearSesionListaParaWebhook({ status: 'completed', channel: channelId });
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});

    await handleGupshupAccountVerified('gs-app-real');

    expect(infoSpy).toHaveBeenCalledWith(
      '[channelOnboardingCompletion] account-event para una sesión que ya no está en gupshup_registering (o ya la reclamó otra entrega concurrente del mismo webhook), no-op',
      expect.objectContaining({ sessionId: String(session._id), currentStatus: 'completed' })
    );
    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();

    infoSpy.mockRestore();
  });

  test('sesión "failed"/"expired": también no-op, no reintenta solo', async () => {
    await crearSesionListaParaWebhook({ status: 'failed', error: { step: 'gupshup_registration', message: 'x' } });

    await handleGupshupAccountVerified('gs-app-real');

    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
  });

  test('estado inconsistente (gupshup_registering pero sin phoneNumber/phoneNumberId): falla ruidoso, sesión queda failed', async () => {
    const session = await crearSesionListaParaWebhook({ meta: { wabaId: 'w' } });

    await handleGupshupAccountVerified('gs-app-real');

    const refrescada = await ChannelOnboardingSession.findById(session._id);
    expect(refrescada.status).toBe('failed');
    expect(refrescada.error.step).toBe('channel_creation');
    expect(refrescada.error.message).toMatch(/sin phoneNumber\/phoneNumberId/);
    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
  });

  test('happy path: crea WhatsAppChannel DEDICATED activo + ChannelCredentials cifrado, completa la sesión, limpia accessTokenCipher', async () => {
    const session = await crearSesionListaParaWebhook();
    partnerAuth.getValidToken.mockResolvedValue('partner-token-real');
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-real-de-la-app' });

    await handleGupshupAccountVerified('gs-app-real');

    expect(partnerApps.getAppAccessToken).toHaveBeenCalledWith('gs-app-real', 'partner-token-real');

    const channel = await WhatsAppChannel.findOne({ providerAppId: 'gs-app-real' });
    expect(channel).not.toBeNull();
    expect(channel.tenantId.toString()).toBe(business._id.toString());
    expect(channel.businessId.toString()).toBe(business._id.toString());
    expect(channel.connectionType).toBe('DEDICATED');
    expect(channel.status).toBe('active');
    expect(channel.onboardingStatus).toBe('completed');
    expect(channel.phoneNumber).toBe('+16315555556');
    expect(channel.phoneNumberId).toBe('pnid-real');
    expect(channel.wabaId).toBe('waba-real');
    expect(channel.providerAccountId).toBe(`creaos${business._id}`); // PR-07a: nombreAppGupshup(tenantId), mismo nombre con el que se creó la app en Gupshup (PR-05)
    expect(channel.webhookReference).toBe('gupshup:account-subscribed');
    expect(channel.displayName).toBe('Línea de ventas');
    expect(channel.credentialsReference).not.toBeNull();

    const credentials = await ChannelCredentials.findOne({ channel: channel._id });
    expect(credentials).not.toBeNull();
    expect(credentials.tenantId.toString()).toBe(business._id.toString());
    expect(credentials.provider).toBe('gupshup');
    expect(credentials.apiKeys).toHaveLength(1);
    expect(credentials.apiKeys[0].revokedAt).toBeNull();
    const apikeyDescifrada = channelCrypto.decrypt(credentials.apiKeys[0].value, String(channel._id));
    expect(apikeyDescifrada).toBe('apikey-real-de-la-app');

    const refrescada = await ChannelOnboardingSession.findById(session._id);
    expect(refrescada.status).toBe('completed');
    expect(refrescada.channel.toString()).toBe(channel._id.toString());
    expect(refrescada.error.step).toBeNull();
    // El token de Meta ya no tiene uso — se limpia por higiene.
    expect(refrescada.meta.accessTokenCipher).toBeNull();
  });

  test('CONCURRENCIA (fix de idempotencia/race condition): 2 entregas casi simultáneas del mismo webhook — solo una crea el canal, la otra hace no-op limpio sin corromper el resultado de la ganadora', async () => {
    await crearSesionListaParaWebhook();
    partnerAuth.getValidToken.mockResolvedValue('partner-token-real');
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-real-de-la-app' });

    // Promise.all() sobre 2 llamadas reales (no mockeadas entre sí) — el
    // reclamo atómico (findOneAndUpdate) es lo único que decide cuál gana,
    // corre contra Mongo real, no es una carrera simulada/artificial.
    await Promise.all([
      handleGupshupAccountVerified('gs-app-real'),
      handleGupshupAccountVerified('gs-app-real'),
    ]);

    // (c) nunca queda un WhatsAppChannel duplicado, sin importar cuál ganó.
    expect(await WhatsAppChannel.countDocuments({ providerAppId: 'gs-app-real' })).toBe(1);
    expect(await ChannelCredentials.countDocuments({})).toBe(1);

    // (a) la ganadora completó la sesión de verdad.
    const refrescada = await ChannelOnboardingSession.findOne({ 'gupshup.appId': 'gs-app-real' });
    expect(refrescada.status).toBe('completed');
    expect(refrescada.channel).not.toBeNull();
    expect(refrescada.error.step).toBeNull();

    // (b) la que pierde nunca llega a trabajar — con el diseño anterior
    // (findOne + save), ambas hubieran llamado a getAppAccessToken() y la
    // perdedora hubiera podido pisar el resultado de la ganadora en el
    // save() final. Acá se ejecuta UNA sola vez.
    expect(partnerApps.getAppAccessToken).toHaveBeenCalledTimes(1);
  });

  test('error de Gupshup al pedir el apikey de la app: la sesión queda failed con error.step:"channel_creation", no crea ningún canal', async () => {
    await crearSesionListaParaWebhook();
    partnerAuth.getValidToken.mockResolvedValue('token');
    partnerApps.getAppAccessToken.mockRejectedValue(Object.assign(new Error('Authentication Failed'), { statusCode: 401 }));

    await handleGupshupAccountVerified('gs-app-real');

    const refrescada = await ChannelOnboardingSession.findOne({ 'gupshup.appId': 'gs-app-real' });
    expect(refrescada.status).toBe('failed');
    expect(refrescada.error.step).toBe('channel_creation');
    expect(refrescada.error.message).toBe('Authentication Failed');
    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
  });

  test('LIMITACIÓN CONOCIDA (documentada): si ChannelCredentials falla DESPUÉS de crear el WhatsAppChannel, el canal queda huérfano sin credenciales y la sesión failed', async () => {
    await crearSesionListaParaWebhook();
    partnerAuth.getValidToken.mockResolvedValue('token');
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-real' });

    // Forzamos el fallo del segundo create() simulando un ChannelCredentials
    // ya existente para el mismo canal target — el índice unique de `channel`
    // hace que el segundo create() de la función bajo prueba choque, sin
    // tener que mockear internals de Mongoose.
    const spy = jest.spyOn(ChannelCredentials, 'create').mockRejectedValueOnce(new Error('fallo simulado de Mongo'));

    await handleGupshupAccountVerified('gs-app-real');

    const canalHuerfano = await WhatsAppChannel.findOne({ providerAppId: 'gs-app-real' });
    expect(canalHuerfano).not.toBeNull(); // el canal SÍ quedó creado
    expect(canalHuerfano.credentialsReference).toBeNull(); // pero sin credenciales

    const refrescada = await ChannelOnboardingSession.findOne({ 'gupshup.appId': 'gs-app-real' });
    expect(refrescada.status).toBe('failed');
    expect(refrescada.error.step).toBe('channel_creation');

    spy.mockRestore();
  });
});
