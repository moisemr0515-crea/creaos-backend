// E2E (Jest, Mongo real en base propia, Gupshup/Meta/OpenAI/colas SIMULADOS) del «modo enlace único» (informes 68/69):
// el cliente pulsa «Conectar WhatsApp», escribe su número y se autoriza UNA sola vez (en el enlace de Gupshup); CREA OS
// crea la app, los callbacks y el enlace, y la conexión se activa por conciliación/webhook hasta recibir un mensaje real.
// Cada paso llama al MISMO handler HTTP que usa el frontend. Lo único simulado son los bordes externos.
process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = 'config-de-prueba';
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
jest.mock('./queues/inbound.queue');
jest.mock('./queues/outbound.queue');

const mongoose = require('mongoose');
const env = require('../../config/env');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const Conversation = require('../ai/conversation.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const InboundEvent = require('./inboundEvent.model');
const OutboundEvent = require('./outboundEvent.model');
const metaEmbeddedSignup = require('./providers/meta/metaEmbeddedSignup.service');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const standardTemplateService = require('./standardTemplate.service');
const { enqueueInbound } = require('./queues/inbound.queue');
const { enqueueOutbound } = require('./queues/outbound.queue');
const aiService = require('../ai/ai.service');
const subscriptionService = require('../subscriptions/subscription.service');
const channelService = require('./channel.service');
const { handleGupshupAccountVerified } = require('./channelOnboardingCompletion.service');
const { handle: handleInbound } = require('./inbound.gateway');
const { processInboundJob } = require('./workers/inbound.worker');
const ctrl = require('./channel.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_link_mode_e2e';
const NUM = { phone: '+51900000401', raw: '51900000401', waba: '1000000000000401', pnid: '1000000000000601' };
const CLIENTE = '51988877766';
const MODELOS = [OutboundEvent, InboundEvent, Conversation, Lead, Pipeline, ChannelCredentials, WhatsAppChannel, ChannelOnboardingSession, Business];

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
async function llamar(handler, req) {
  const res = mockRes();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls.length) {
    const error = next.mock.calls[0][0];
    return { status: error.statusCode || 500, body: null, error };
  }
  return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0], error: null };
}

describe('E2E modo enlace único — Conectar WhatsApp → una autorización → canal activo → mensaje → lead → respuesta IA', () => {
  let tenant;
  let otroTenant;
  let vivas;
  const usuario = { email: 'cliente@creaos.test', name: 'Cliente Nuevo' };
  const reqDe = (t, body = {}) => ({ businessId: t._id, user: usuario, body });
  const entorno = { enabled: env.ONBOARDING_LINK_MODE_ENABLED, tenants: env.ONBOARDING_LINK_MODE_TENANTS, from: env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM };
  const actual = async (t = tenant) => (await llamar(ctrl.getCurrentEmbeddedSignup, reqDe(t))).body.data.onboarding;
  const verificar = (sessionId, t = tenant) => llamar(ctrl.reconcileEmbeddedSignup, reqDe(t, { sessionId }));
  const ponerLive = (appId, num = NUM, over = {}) => { vivas[appId] = { phone: num.raw, phoneId: num.pnid, wabaId: num.waba, accountStatus: 'ACTIVE', ...over }; };
  const mensajeEntrante = (canal, id, texto = 'Hola, quiero información') => ({
    object: 'whatsapp_business_account',
    gs_app_id: canal.providerAppId,
    entry: [{
      id: canal.wabaId,
      changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: canal.phoneNumberId, display_phone_number: canal.phoneNumber.replace('+', '') },
        contacts: [{ profile: { name: 'Cliente Real' }, wa_id: CLIENTE }],
        messages: [{ from: CLIENTE, id, type: 'text', text: { body: texto } }],
      } }],
    }],
  });

  beforeAll(async () => { await mongoose.connect(MONGO_URI); });
  afterAll(async () => {
    for (const m of MODELOS) await m.deleteMany({});
    await mongoose.disconnect();
    Object.assign(env, { ONBOARDING_LINK_MODE_ENABLED: entorno.enabled, ONBOARDING_LINK_MODE_TENANTS: entorno.tenants, ONBOARDING_LINK_MODE_NEW_TENANTS_FROM: entorno.from });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    for (const m of MODELOS) await m.deleteMany({});
    Object.assign(env, { ONBOARDING_LINK_MODE_ENABLED: true, ONBOARDING_LINK_MODE_TENANTS: [], ONBOARDING_LINK_MODE_NEW_TENANTS_FROM: null });
    tenant = await Business.create({ name: 'Cuenta Nueva' });
    otroTenant = await Business.create({ name: 'Otro Cliente' });
    env.ONBOARDING_LINK_MODE_TENANTS = [String(tenant._id), String(otroTenant._id)]; // la habilitación automática de negocios nuevos se prueba en channel.linkMode.newTenants.e2e.test.js
    vivas = {};
    partnerAuth.getValidToken.mockResolvedValue('partner-token');
    partnerApps.createApp.mockImplementation(async ({ name }) => ({ appId: `app-${name}` }));
    partnerApps.getPartnerApps.mockResolvedValue([]);
    partnerApps.getAppAccessToken.mockImplementation(async (appId) => ({ apikey: `apikey-de-${appId}` }));
    partnerApps.getWabaInfo.mockImplementation(async (appId) => {
      if (!vivas[appId]) throw Object.assign(new Error('Gupshup Partner API rechazó la solicitud (getWabaInfo): App is not live.'), { statusCode: 400 });
      return vivas[appId];
    });
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockImplementation(async (appId) => ({ link: `https://gs.tc.im/${appId}` }));
    partnerSubscriptions.subscribeToEvents.mockResolvedValue({ status: 'success' });
    partnerSubscriptions.getSubscriptions.mockResolvedValue([]);
    standardTemplateService.ensureStandardTemplatesForChannel.mockResolvedValue({ created: [], catalog: [] });
    enqueueInbound.mockResolvedValue(undefined);
    enqueueOutbound.mockResolvedValue(undefined);
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({ planName: 'trial', limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true } });
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: '¡Hola! Con gusto te ayudo, ¿qué necesitas?', tokensUsed: 20 });
    jest.spyOn(aiService, 'qualifyLead').mockResolvedValue({ score: 60, temperature: 'warm' });
  });

  test('CRITERIO DE ACEPTACIÓN: cuenta nueva → «Conectar» con su número → UNA autorización (enlace de Gupshup) → canal activo → mensaje real → lead → respuesta de la IA', async () => {
    // 0. el negocio ve el modo activo; nada en curso ni canal
    expect((await llamar(ctrl.getOnboardingMode, reqDe(tenant))).body.data).toEqual({ mode: 'gupshup_link' });
    expect(await actual()).toBeNull();

    // 1. «Conectar WhatsApp»: UNA solicitud crea la sesión, la app, los callbacks y el enlace
    const inicio = await llamar(ctrl.startLinkOnboarding, reqDe(tenant, { phoneNumber: ' +51 900 000 401 ' }));
    expect(inicio.status).toBe(200);
    const { sessionId, embedSignupUrl, onboarding } = inicio.body.data;
    const appId = embedSignupUrl.split('/').pop();
    expect(embedSignupUrl).toBe(`https://gs.tc.im/${appId}`);
    expect(onboarding).toMatchObject({ phase: 'awaiting_gupshup', nextAction: 'open_link', mode: 'gupshup_link', phoneNumber: NUM.phone });
    expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
    const suscripciones = partnerSubscriptions.subscribeToEvents.mock.calls.map(([, , cfg]) => ({ url: cfg.url, modes: cfg.modes }));
    expect(suscripciones).toEqual(expect.arrayContaining([
      expect.objectContaining({ modes: ['ACCOUNT'], url: `https://backend.creaos.test/api/v1/webhooks/gupshup/onboarding/${appId}` }),
      expect.objectContaining({ modes: ['ALL'], url: 'https://backend.creaos.test/api/v1/webhooks/gupshup' }),
    ]));
    expect(partnerApps.setContactDetails).toHaveBeenCalledWith(appId, { contactEmail: usuario.email, contactName: usuario.name, contactNumber: NUM.phone }, 'partner-token');

    // Una sola autorización: no se usó nada de la ventana de Meta de CREA OS
    expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled();
    expect(metaEmbeddedSignup.resolvePhoneNumber).not.toHaveBeenCalled();

    // 2. clic doble / recarga: la misma sesión, sin otra app ni otro enlace
    const repetido = await llamar(ctrl.startLinkOnboarding, reqDe(tenant, { phoneNumber: NUM.phone }));
    expect(repetido.body.data.sessionId).toBe(sessionId);
    expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
    expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledTimes(1);
    expect(await actual()).toMatchObject({ sessionId, phase: 'awaiting_gupshup', embedSignupUrl });

    // 3. «Ya terminé» antes de que Gupshup confirme: pendiente, sin canal
    expect((await verificar(sessionId)).body.data.outcome).toBe('pending');
    expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id })).toBe(0);

    // 4. El cliente completa la ventana de Gupshup con SU número → la app queda Live → «Ya terminé» activa el canal
    ponerLive(appId);
    expect((await verificar(sessionId)).body.data.outcome).toBe('completed');
    expect((await verificar(sessionId)).body.data.outcome).toBe('already_completed');

    const canal = await WhatsAppChannel.findOne({ tenantId: tenant._id });
    expect(await WhatsAppChannel.countDocuments({})).toBe(1);
    expect(canal).toMatchObject({ status: 'active', onboardingStatus: 'completed', connectionType: 'DEDICATED', outboundApi: 'partner', phoneNumber: NUM.phone, providerAppId: appId });
    expect(String(canal.businessId)).toBe(String(tenant._id));
    expect(await ChannelCredentials.countDocuments({ channel: canal._id })).toBe(1);
    expect(await actual()).toBeNull();
    expect(String((await channelService.getChannelForTenant(tenant._id))._id)).toBe(String(canal._id));
    expect((await ChannelOnboardingSession.findById(sessionId)).status).toBe('completed');

    // 5. Mensaje real: gateway → canal/tenant correctos → lead + conversación + respuesta de la IA
    await handleInbound(mensajeEntrante(canal, 'wamid.PRIMERO'));
    const evento = await InboundEvent.findOne({ providerMessageId: 'wamid.PRIMERO' });
    expect(String(evento.tenantId)).toBe(String(tenant._id));
    expect(String(evento.channel)).toBe(String(canal._id));
    await processInboundJob({ data: { inboundEventId: evento._id } });
    expect(await Lead.countDocuments({ business: tenant._id })).toBe(1);
    expect(aiService.generateReply).toHaveBeenCalledTimes(1);
    expect(await OutboundEvent.countDocuments({ sourceInboundEvent: evento._id, origin: 'ai' })).toBe(1);

    // 6. el otro negocio no ve nada de esto
    expect(await actual(otroTenant)).toBeNull();
    expect(await channelService.getChannelForTenant(otroTenant._id)).toBeNull();
  });

  test('activación por webhook ACCOUNT_VERIFIED (sin «Ya terminé»), con reentrega: un solo canal', async () => {
    const inicio = await llamar(ctrl.startLinkOnboarding, reqDe(tenant, { phoneNumber: NUM.phone }));
    const appId = inicio.body.data.embedSignupUrl.split('/').pop();
    ponerLive(appId);
    await handleGupshupAccountVerified(appId);
    await handleGupshupAccountVerified(appId);
    expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id, status: 'active' })).toBe(1);
    expect(await actual()).toBeNull();
  });

  test('el cliente elige OTRO número en la ventana de Gupshup: mismatch, nada se activa y el estado lo explica', async () => {
    const inicio = await llamar(ctrl.startLinkOnboarding, reqDe(tenant, { phoneNumber: NUM.phone }));
    const { sessionId } = inicio.body.data;
    ponerLive(inicio.body.data.embedSignupUrl.split('/').pop(), NUM, { phone: '51999999999' });

    const r = await verificar(sessionId);
    expect(r.body.data).toMatchObject({ outcome: 'mismatch', expected: NUM.phone, found: '+51999999999' });
    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
  });

  test('interruptor APAGADO (valor por defecto): /mode dice flujo clásico, /start responde 404 y no se crea ni llama nada', async () => {
    env.ONBOARDING_LINK_MODE_ENABLED = false;
    expect((await llamar(ctrl.getOnboardingMode, reqDe(tenant))).body.data).toEqual({ mode: 'meta_then_link' });
    const r = await llamar(ctrl.startLinkOnboarding, reqDe(tenant, { phoneNumber: NUM.phone }));
    expect(r.status).toBe(404);
    expect(await ChannelOnboardingSession.countDocuments({})).toBe(0);
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
    expect(partnerApps.createApp).not.toHaveBeenCalled();
  });

  test('el flujo clásico (init → code → callback → complete-gupshup) sigue funcionando con el modo enlace activo en el entorno', async () => {
    metaEmbeddedSignup.exchangeCode.mockResolvedValue('token-meta');
    metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: NUM.phone, verifiedName: 'Mi negocio' });
    const init = await llamar(ctrl.initEmbeddedSignup, reqDe(otroTenant));
    const sessionId = String(init.body.data.sessionId);
    expect((await llamar(ctrl.codeEmbeddedSignup, reqDe(otroTenant, { sessionId, code: 'c' }))).status).toBe(200);
    expect((await llamar(ctrl.callbackEmbeddedSignup, reqDe(otroTenant, { sessionId, wabaId: NUM.waba, phoneNumberId: NUM.pnid }))).status).toBe(200);
    const registro = await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(otroTenant, { sessionId }));
    expect(registro.status).toBe(200);
    const appId = registro.body.data.embedSignupUrl.split('/').pop();
    ponerLive(appId);
    expect((await verificar(sessionId, otroTenant)).body.data.outcome).toBe('completed');
    expect(await WhatsAppChannel.countDocuments({ tenantId: otroTenant._id, status: 'active' })).toBe(1);
  });
});
