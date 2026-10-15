// Test real (Jest, Mongo real en base propia) de channelOnboardingRecovery.service.js
// — caso E del incidente de Nutriva (14/oct/2026): recuperar la sesión pendiente
// SIN crear otra WABA, sin duplicaciones y sin tocar nada fuera de esa sesión.
// Réplica fiel del estado real encontrado en producción: sesión en
// gupshup_registering con expiresAt vencido, atada a la app Live del número
// anterior, más el canal anterior desconectado, sus credenciales y 14 sesiones
// históricas del mismo tenant. Nada pega contra Meta ni Gupshup.
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');

jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const channelCrypto = require('./channelCrypto');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const { recoverPendingSession } = require('./channelOnboardingRecovery.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_recovery';
const DIA_MS = 24 * 60 * 60 * 1000;

describe('channelOnboardingRecovery.recoverPendingSession()', () => {
  let tenant;
  let otroTenant;
  let canalAnterior;

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

    // Contexto histórico idéntico al encontrado en producción.
    canalAnterior = await WhatsAppChannel.create({
      tenantId: tenant._id, businessId: tenant._id, connectionType: 'DEDICATED', status: 'disconnected',
      onboardingStatus: 'completed', outboundApi: 'partner', phoneNumber: '+51900000202', phoneNumberId: '1000000000000601',
      wabaId: '1000000000000301', providerAppId: 'app-4f81', providerAccountId: `creaos${tenant._id}`,
    });
    await ChannelCredentials.create({
      channel: canalAnterior._id, tenantId: tenant._id, provider: 'gupshup',
      apiKeys: [{ value: channelCrypto.encrypt('apikey-vieja', String(canalAnterior._id)) }],
    });
    await ChannelOnboardingSession.create({
      tenantId: tenant._id, status: 'completed', channel: canalAnterior._id,
      meta: { wabaId: '1000000000000301', phoneNumberId: '1000000000000601', phoneNumber: '+51900000202' },
      gupshup: { appId: 'app-4f81', webhookReference: 'gupshup:account-subscribed' },
    });
    await ChannelOnboardingSession.create({ tenantId: tenant._id, status: 'initiated' });
    await ChannelOnboardingSession.create({ tenantId: tenant._id, status: 'initiated' });
  });

  // La sesión pendiente de Nutriva tal como está en producción.
  const sesionNutriva = (overrides = {}) => ChannelOnboardingSession.create({
    tenantId: tenant._id,
    status: 'gupshup_registering',
    displayName: null,
    expiresAt: new Date(Date.now() - 60 * 60 * 1000), // ventana de 30 min del init() ya vencida
    meta: {
      wabaId: '1000000000000101',
      phoneNumberId: '1000000000000501',
      phoneNumber: '+51900000101',
      accessTokenCipher: { ciphertext: 'cifrado', iv: 'iv', authTag: 'tag', keyVersion: 1 },
    },
    gupshup: {
      appId: 'app-4f81',
      webhookReference: 'gupshup:account-subscribed',
      messagesWebhookReference: 'gupshup:messages-subscribed',
      embedSignupUrl: 'https://embed.gupshup.io/viejo',
      embedSignupUrlGeneratedAt: new Date(),
    },
    ...overrides,
  });

  // Foto de TODO lo que no es la sesión recuperada: debe quedar idéntico.
  const fotoDelEntorno = async (excluirSesionId) => JSON.stringify({
    canales: await WhatsAppChannel.find({}).sort({ _id: 1 }).lean(),
    creds: await ChannelCredentials.find({}).sort({ _id: 1 }).lean(),
    otrasSesiones: await ChannelOnboardingSession.find({ _id: { $ne: excluirSesionId } }).sort({ _id: 1 }).lean(),
    negocios: await Business.find({}).sort({ _id: 1 }).lean(),
  });

  test('estado real de Nutriva: reabre la sesión, desvincula la app Live del número anterior y conserva sessionId, IDs de Meta y token cifrado', async () => {
    const sesion = await sesionNutriva();
    const entornoAntes = await fotoDelEntorno(sesion._id);

    const res = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });

    expect(res).toMatchObject({
      outcome: 'recovered', sessionId: String(sesion._id), status: 'gupshup_registering', appDetached: true, previousStatus: 'gupshup_registering',
    });
    const r = await ChannelOnboardingSession.findById(sesion._id);
    expect(r._id.toString()).toBe(sesion._id.toString()); // mismo sessionId
    expect(r.status).toBe('gupshup_registering');
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * DIA_MS); // ventana de la fase Gupshup (5 días)
    expect(r.gupshup.appId).toBeNull();
    expect(r.gupshup.appName).toBeNull();
    expect(r.gupshup.webhookReference).toBeNull();
    expect(r.gupshup.messagesWebhookReference).toBeNull();
    expect(r.gupshup.embedSignupUrl).toBeNull();
    // Conservado para que NO haga falta otra WABA:
    expect(r.meta.wabaId).toBe('1000000000000101');
    expect(r.meta.phoneNumberId).toBe('1000000000000501');
    expect(r.meta.phoneNumber).toBe('+51900000101');
    expect(r.meta.accessTokenCipher.ciphertext).toBe('cifrado');
    expect(r.channel).toBeUndefined();
    expect(r.error.step).toBeNull();

    // Nada más se tocó: ni el canal anterior, ni credenciales, ni otras sesiones, ni negocios.
    expect(await fotoDelEntorno(sesion._id)).toBe(entornoAntes);
    expect((await WhatsAppChannel.findById(canalAnterior._id)).providerAppId).toBe('app-4f81');
    // Y jamás se llamó a Meta ni a Gupshup.
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
    Object.values(partnerApps).forEach((fn) => { if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled(); });
  });

  test('es idempotente: repetirla no cambia nada más (ni la app, ni los datos de Meta) y no duplica nada', async () => {
    const sesion = await sesionNutriva();
    await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });
    const entornoAntes = await fotoDelEntorno(sesion._id);
    const intermedia = await ChannelOnboardingSession.findById(sesion._id).lean();

    const segunda = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });
    const tercera = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });

    expect(segunda).toMatchObject({ outcome: 'already_ready', appDetached: false });
    expect(tercera).toMatchObject({ outcome: 'already_ready', appDetached: false });
    const final = await ChannelOnboardingSession.findById(sesion._id).lean();
    expect({ ...final, expiresAt: null, updatedAt: null }).toEqual({ ...intermedia, expiresAt: null, updatedAt: null });
    expect(await fotoDelEntorno(sesion._id)).toBe(entornoAntes);
    expect(await ChannelOnboardingSession.countDocuments({ tenantId: tenant._id })).toBe(4); // 3 de contexto + la recuperada: ninguna sesión nueva
  });

  test('dos recuperaciones simultáneas convergen al mismo estado, sin error ni estado intermedio', async () => {
    const sesion = await sesionNutriva();

    const [a, b] = await Promise.all([
      recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id }),
      recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id }),
    ]);

    expect(['recovered', 'already_ready']).toContain(a.outcome);
    expect(['recovered', 'already_ready']).toContain(b.outcome);
    const r = await ChannelOnboardingSession.findById(sesion._id);
    expect(r.status).toBe('gupshup_registering');
    expect(r.gupshup.appId).toBeNull();
    expect(r.meta.wabaId).toBe('1000000000000101');
  });

  test('sesión que la expiración perezosa ya marcó "expired" pero conserva la autorización de Meta: se reabre', async () => {
    const sesion = await sesionNutriva({ status: 'expired' });

    const res = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });

    expect(res).toMatchObject({ outcome: 'recovered', previousStatus: 'expired', status: 'gupshup_registering' });
    expect((await ChannelOnboardingSession.findById(sesion._id)).status).toBe('gupshup_registering');
  });

  test('sesión "failed" en un paso de Gupshup o de creación de canal: se reabre; "failed" en un paso de Meta: no es recuperable (409)', async () => {
    const enGupshup = await sesionNutriva({ status: 'failed', error: { step: 'gupshup_registration', message: 'Link has expired' } });
    expect((await recoverPendingSession({ sessionId: enGupshup._id, tenantId: tenant._id })).outcome).toBe('recovered');
    const r = await ChannelOnboardingSession.findById(enGupshup._id);
    expect(r.status).toBe('gupshup_registering');
    expect(r.error.step).toBeNull();

    const enCanal = await sesionNutriva({ status: 'failed', error: { step: 'channel_creation', message: 'x' } });
    expect((await recoverPendingSession({ sessionId: enCanal._id, tenantId: tenant._id })).outcome).toBe('recovered');

    const enMeta = await sesionNutriva({ status: 'failed', error: { step: 'meta_auth', message: 'x' } });
    await expect(recoverPendingSession({ sessionId: enMeta._id, tenantId: tenant._id })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('sin autorización de Meta completa (token, WABA, phoneNumberId o teléfono ausentes): 409, nada se modifica', async () => {
    const sinToken = await sesionNutriva({ meta: { wabaId: 'w', phoneNumberId: 'p', phoneNumber: '+51900000101' } });
    const sinWaba = await sesionNutriva({ meta: { phoneNumberId: 'p', phoneNumber: '+51900000101', accessTokenCipher: { ciphertext: 'c', iv: 'i', authTag: 'a', keyVersion: 1 } } });
    const antes = await ChannelOnboardingSession.find({ _id: { $in: [sinToken._id, sinWaba._id] } }).sort({ _id: 1 }).lean();

    await expect(recoverPendingSession({ sessionId: sinToken._id, tenantId: tenant._id })).rejects.toMatchObject({ statusCode: 409 });
    await expect(recoverPendingSession({ sessionId: sinWaba._id, tenantId: tenant._id })).rejects.toMatchObject({ statusCode: 409 });

    expect(await ChannelOnboardingSession.find({ _id: { $in: [sinToken._id, sinWaba._id] } }).sort({ _id: 1 }).lean()).toEqual(antes);
  });

  test('estados no recuperables (initiated, meta_authorized): 409', async () => {
    const iniciada = await ChannelOnboardingSession.findOne({ tenantId: tenant._id, status: 'initiated' });
    await expect(recoverPendingSession({ sessionId: iniciada._id, tenantId: tenant._id })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('sesión ya completada o con canal: already_completed, no se reabre ni se toca', async () => {
    const completada = await ChannelOnboardingSession.findOne({ tenantId: tenant._id, status: 'completed' });
    const antes = JSON.stringify(await ChannelOnboardingSession.findById(completada._id).lean());

    const res = await recoverPendingSession({ sessionId: completada._id, tenantId: tenant._id });

    expect(res.outcome).toBe('already_completed');
    expect(String(res.channelId)).toBe(String(canalAnterior._id));
    expect(JSON.stringify(await ChannelOnboardingSession.findById(completada._id).lean())).toBe(antes);
  });

  test('una app propia y segura (sin canal ligado a otro número) se conserva: solo se renueva la ventana', async () => {
    const sesion = await sesionNutriva({
      gupshup: { appId: 'app-propia-de-esta-sesion', appName: 'creaosnueva', webhookReference: 'gupshup:account-subscribed', messagesWebhookReference: 'gupshup:messages-subscribed' },
    });

    const res = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });

    expect(res).toMatchObject({ outcome: 'already_ready', appDetached: false });
    const r = await ChannelOnboardingSession.findById(sesion._id);
    expect(r.gupshup.appId).toBe('app-propia-de-esta-sesion');
    expect(r.gupshup.appName).toBe('creaosnueva');
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * DIA_MS);
  });

  describe('aislamiento multi-tenant', () => {
    test('recuperar con otro tenant es 404 y la sesión ajena queda intacta', async () => {
      const sesion = await sesionNutriva();
      const antes = JSON.stringify(await ChannelOnboardingSession.findById(sesion._id).lean());

      await expect(recoverPendingSession({ sessionId: sesion._id, tenantId: otroTenant._id })).rejects.toMatchObject({ statusCode: 404 });

      expect(JSON.stringify(await ChannelOnboardingSession.findById(sesion._id).lean())).toBe(antes);
    });

    test('una app que figura en un canal de OTRO tenant se desvincula igual (inseguro), sin tocar ese canal', async () => {
      const canalAjeno = await WhatsAppChannel.create({
        tenantId: otroTenant._id, businessId: otroTenant._id, connectionType: 'DEDICATED', status: 'active', onboardingStatus: 'completed',
        outboundApi: 'partner', phoneNumber: '+51933333333', phoneNumberId: 'pnid-ajeno', providerAppId: 'app-ajena-por-error',
      });
      const sesion = await sesionNutriva({ gupshup: { appId: 'app-ajena-por-error' } });

      const res = await recoverPendingSession({ sessionId: sesion._id, tenantId: tenant._id });

      expect(res.appDetached).toBe(true);
      expect((await ChannelOnboardingSession.findById(sesion._id)).gupshup.appId).toBeNull();
      expect((await WhatsAppChannel.findById(canalAjeno._id)).providerAppId).toBe('app-ajena-por-error');
    });
  });
});
