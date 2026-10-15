// E2E (Jest, Mongo real en base propia, Meta/Gupshup/OpenAI/colas SIMULADOS) del autoservicio de
// WhatsApp de CREA OS: lo que hace el frontend desde que el cliente pulsa «Conectar WhatsApp»
// hasta que un mensaje real llega, crea un lead y recibe una respuesta de la IA.
//
// Cada paso llama al MISMO handler HTTP que usa el frontend (init, code, callback,
// complete-gupshup, current, reconcile, recover) y al mismo gateway/worker de producción.
// Lo único simulado son los bordes externos: Meta, el Partner API de Gupshup, OpenAI y BullMQ.
// Incidente de Nutriva (14/oct/2026): ver docs/known-issues y el commit 60b271f.
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
const channelCredentialsService = require('./channelCredentials.service');
const { handleGupshupAccountVerified } = require('./channelOnboardingCompletion.service');
const { sweepPendingOnboardingSessions } = require('./channelOnboardingReconcileSweep.service');
const { handle: handleInbound } = require('./inbound.gateway');
const { processInboundJob } = require('./workers/inbound.worker');
const ctrl = require('./channel.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_self_service_e2e';
const MIN = 60 * 1000;
const DIA = 24 * 60 * MIN;

// Números y IDs ficticios de formato válido.
const NUM_A = { phone: '+51900000101', raw: '51900000101', waba: '1000000000000101', pnid: '1000000000000501' };
const NUM_B = { phone: '+51900000303', raw: '51900000303', waba: '1000000000000701', pnid: '1000000000000801' };
const CLIENTE = '51988877766';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** Llama a un handler como lo haría Express y devuelve { status, body, error }. */
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

describe('E2E autoservicio — Conectar WhatsApp → canal activo → mensaje → lead → respuesta IA', () => {
  let tenant;
  let otroTenant;
  let vivas; // appId -> info de waba/info cuando la app ya está Live
  let appsCreadas;

  const usuario = { email: 'cliente@creaos.test', name: 'Cliente Nuevo' };
  const reqDe = (t, body = {}) => ({ businessId: t._id, user: usuario, body });
  const ponerLive = (appId, num) => {
    vivas[appId] = { phone: num.raw, phoneId: num.pnid, wabaId: num.waba, wabaName: 'Mi negocio', accountStatus: 'ACTIVE' };
  };

  beforeAll(async () => { await mongoose.connect(MONGO_URI); });
  afterAll(async () => {
    for (const m of [OutboundEvent, InboundEvent, Conversation, Lead, Pipeline, ChannelCredentials, WhatsAppChannel, ChannelOnboardingSession, Business]) await m.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    for (const m of [OutboundEvent, InboundEvent, Conversation, Lead, Pipeline, ChannelCredentials, WhatsAppChannel, ChannelOnboardingSession, Business]) await m.deleteMany({});
    tenant = await Business.create({ name: 'Cuenta Nueva' });
    otroTenant = await Business.create({ name: 'Otro Cliente' });
    vivas = {};
    appsCreadas = [];

    metaEmbeddedSignup.exchangeCode.mockResolvedValue('token-meta-del-cliente');
    metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: NUM_A.phone, verifiedName: 'Mi negocio' });
    partnerAuth.getValidToken.mockResolvedValue('partner-token');
    partnerApps.createApp.mockImplementation(async ({ name }) => { const appId = `app-${name}`; appsCreadas.push(appId); return { appId }; });
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
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      planName: 'trial', limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    });
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: '¡Hola! Con gusto te ayudo, ¿qué necesitas?', tokensUsed: 20 });
    jest.spyOn(aiService, 'qualifyLead').mockResolvedValue({ score: 60, temperature: 'warm' });
  });

  // ── pasos que el frontend ejecuta en secuencia ──────────────────────────
  async function conectarHastaGupshup(t = tenant, num = NUM_A) {
    metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: num.phone, verifiedName: 'Mi negocio' });
    const init = await llamar(ctrl.initEmbeddedSignup, reqDe(t));
    expect(init.status).toBe(201);
    const { sessionId } = init.body.data;
    expect(init.body.data.metaConfig).toEqual({ appId: 'meta-app-id-de-prueba', configId: 'config-de-prueba' });
    expect((await llamar(ctrl.codeEmbeddedSignup, reqDe(t, { sessionId: String(sessionId), code: 'code-de-meta' }))).status).toBe(200);
    expect((await llamar(ctrl.callbackEmbeddedSignup, reqDe(t, { sessionId: String(sessionId), wabaId: num.waba, phoneNumberId: num.pnid }))).status).toBe(200);
    const registro = await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(t, { sessionId: String(sessionId) }));
    return { sessionId: String(sessionId), registro };
  }
  const actual = async (t = tenant) => (await llamar(ctrl.getCurrentEmbeddedSignup, reqDe(t))).body.data.onboarding;
  const verificar = (sessionId, t = tenant) => llamar(ctrl.reconcileEmbeddedSignup, reqDe(t, { sessionId }));
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

  // ─────────────────────────────────────────────────────────────────────────
  test('CRITERIO DE ACEPTACIÓN: cuenta nueva → conectar → autorizar en Meta → enlace de Gupshup → canal activo → mensaje real → lead → respuesta automática de la IA', async () => {
    // 0. cuenta nueva: nada en curso ni canal
    expect(await actual()).toBeNull();
    expect(await channelService.getChannelForTenant(tenant._id)).toBeNull();

    // 1-4. Conectar WhatsApp: init → popup de Meta (code) → callback → complete-gupshup (automático)
    const { sessionId, registro } = await conectarHastaGupshup();
    expect(registro.status).toBe(200);
    const appId = registro.body.data.embedSignupUrl.split('/').pop();
    expect(registro.body.data.embedSignupUrl).toBe(`https://gs.tc.im/${appId}`);
    expect(partnerApps.createApp).toHaveBeenCalledTimes(1); // UNA app para esta conexión
    // webhooks de eventos y de mensajes suscritos hacia CREA OS
    const suscripciones = partnerSubscriptions.subscribeToEvents.mock.calls.map(([, , cfg]) => ({ tag: cfg.tag, url: cfg.url, modes: cfg.modes }));
    expect(suscripciones).toEqual(expect.arrayContaining([
      expect.objectContaining({ modes: ['ACCOUNT'], url: `https://backend.creaos.test/api/v1/webhooks/gupshup/onboarding/${appId}` }),
      expect.objectContaining({ modes: ['ALL'], url: 'https://backend.creaos.test/api/v1/webhooks/gupshup' }),
    ]));

    // 5. el frontend ve la conexión en curso con el enlace (para abrirlo con un clic del usuario)
    expect(await actual()).toMatchObject({ sessionId, phase: 'awaiting_gupshup', nextAction: 'open_link', embedSignupUrl: `https://gs.tc.im/${appId}`, phoneNumber: NUM_A.phone });

    // 6. «Ya terminé» mientras Gupshup todavía no confirma: pendiente, sin canal
    const pendiente = await verificar(sessionId);
    expect(pendiente.body.data.outcome).toBe('pending');
    expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id })).toBe(0);
    expect((await actual()).phase).toBe('awaiting_gupshup');

    // 7. El cliente completa el flujo de Gupshup/Meta: la app queda Live con SU número → «Ya terminé» activa el canal
    ponerLive(appId, NUM_A);
    const activado = await verificar(sessionId);
    expect(activado.body.data.outcome).toBe('completed');

    const canal = await WhatsAppChannel.findOne({ tenantId: tenant._id });
    expect(await WhatsAppChannel.countDocuments({})).toBe(1);
    expect(canal).toMatchObject({
      status: 'active', onboardingStatus: 'completed', connectionType: 'DEDICATED', outboundApi: 'partner',
      phoneNumber: NUM_A.phone, phoneNumberId: NUM_A.pnid, wabaId: NUM_A.waba, providerAppId: appId,
    });
    expect(String(canal.businessId)).toBe(String(tenant._id));
    expect(await ChannelCredentials.countDocuments({ channel: canal._id })).toBe(1);
    expect((await channelCredentialsService.resolveCredentials(canal)).apiKey).toBe(`apikey-de-${appId}`);
    expect(await actual()).toBeNull(); // ya no hay nada en curso
    expect(String((await channelService.getChannelForTenant(tenant._id))._id)).toBe(String(canal._id));
    const sesionFinal = await ChannelOnboardingSession.findById(sessionId);
    expect(sesionFinal.status).toBe('completed');
    expect(sesionFinal.meta.accessTokenCipher).toBeNull(); // el token de Meta no se conserva una vez conectado

    // 8. Primer mensaje REAL del cliente final: webhook → gateway → canal/tenant correctos
    await handleInbound(mensajeEntrante(canal, 'wamid.PRIMERO'));
    const evento = await InboundEvent.findOne({ providerMessageId: 'wamid.PRIMERO' });
    expect(evento).toMatchObject({ status: 'received', from: CLIENTE });
    expect(String(evento.tenantId)).toBe(String(tenant._id));
    expect(String(evento.channel)).toBe(String(canal._id));
    expect(enqueueInbound).toHaveBeenCalledTimes(1);

    // 9. El worker procesa: lead + conversación + respuesta automática de la IA
    await processInboundJob({ data: { inboundEventId: evento._id } });
    expect((await InboundEvent.findById(evento._id)).status).toBe('processed');
    const leads = await Lead.find({ business: tenant._id });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ source: 'whatsapp', phone: '+51988877766', pipelineStage: 'new' });
    expect(leads[0].pipeline).toBeTruthy(); // visible en el pipeline del negocio
    const conversacion = await Conversation.findOne({ business: tenant._id });
    expect(String(conversacion.whatsappChannel)).toBe(String(canal._id));
    expect(aiService.generateReply).toHaveBeenCalledTimes(1);
    const respuesta = await OutboundEvent.findOne({ sourceInboundEvent: evento._id }).lean();
    expect(respuesta).toMatchObject({ origin: 'ai', status: 'pending' }); // BullMQ simulado: pasa a 'queued' al encolar de verdad
    expect(String(respuesta.tenantId)).toBe(String(tenant._id));
    expect(String(respuesta.channel)).toBe(String(canal._id));
    expect(enqueueOutbound).toHaveBeenCalledWith(respuesta._id);

    // 10. Reentrega del mismo webhook y segundo mensaje: sin duplicados
    await handleInbound(mensajeEntrante(canal, 'wamid.PRIMERO'));
    expect(await InboundEvent.countDocuments({ providerMessageId: 'wamid.PRIMERO' })).toBe(1);
    await handleInbound(mensajeEntrante(canal, 'wamid.SEGUNDO', 'Gracias, ¿precio?'));
    await processInboundJob({ data: { inboundEventId: (await InboundEvent.findOne({ providerMessageId: 'wamid.SEGUNDO' }))._id } });
    expect(await Lead.countDocuments({ business: tenant._id })).toBe(1);
    expect(await Conversation.countDocuments({ business: tenant._id })).toBe(1);
    expect(await WhatsAppChannel.countDocuments({})).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('activación sin que el cliente haga nada más', () => {
    test('el webhook ACCOUNT_VERIFIED activa el canal y el estado en curso desaparece', async () => {
      const { sessionId, registro } = await conectarHastaGupshup();
      const appId = registro.body.data.embedSignupUrl.split('/').pop();
      ponerLive(appId, NUM_A);

      await handleGupshupAccountVerified(appId);

      expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id, status: 'active' })).toBe(1);
      expect((await ChannelOnboardingSession.findById(sessionId)).completedVia).toBe('webhook');
      expect(await actual()).toBeNull();
    });

    test('sin webhook ni clic: el barrido automático del Worker activa el canal cuando Gupshup confirma el número', async () => {
      const { sessionId, registro } = await conectarHastaGupshup();
      const appId = registro.body.data.embedSignupUrl.split('/').pop();
      await ChannelOnboardingSession.updateOne({ _id: sessionId }, { $set: { 'gupshup.embedSignupUrlGeneratedAt': new Date(Date.now() - 10 * MIN) } });

      const antes = await sweepPendingOnboardingSessions();
      expect(antes).toMatchObject({ revisadas: 1, pendientes: 1, completadas: 0 }); // Gupshup aún no Live
      ponerLive(appId, NUM_A);
      const despues = await sweepPendingOnboardingSessions({ now: new Date(Date.now() + 5 * MIN) });

      expect(despues).toMatchObject({ revisadas: 1, completadas: 1 });
      expect((await ChannelOnboardingSession.findById(sessionId)).completedVia).toBe('reconcile');
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id, status: 'active' })).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('retomar y recuperar sin intervención técnica', () => {
    test('cerrar la pestaña y volver: /current devuelve la misma conexión con su enlace, y repetir complete-gupshup no crea otra app', async () => {
      const { sessionId, registro } = await conectarHastaGupshup();
      const appId = registro.body.data.embedSignupUrl.split('/').pop();

      const alVolver = await actual(); // «recarga» del navegador: no hay estado en memoria
      expect(alVolver).toMatchObject({ sessionId, phase: 'awaiting_gupshup', embedSignupUrl: `https://gs.tc.im/${appId}` });

      const repetido = await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(tenant, { sessionId }));
      expect(repetido.status).toBe(200);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(await ChannelOnboardingSession.countDocuments({ tenantId: tenant._id })).toBe(1);
      expect(appsCreadas).toEqual([appId]);
    });

    test('el enlace/ventana venció: /current lo indica, recover + complete-gupshup generan un enlace nuevo SIN repetir Meta ni crear otra app', async () => {
      const { sessionId, registro } = await conectarHastaGupshup();
      const appId = registro.body.data.embedSignupUrl.split('/').pop();
      await ChannelOnboardingSession.updateOne({ _id: sessionId }, { $set: { expiresAt: new Date(Date.now() - MIN) } });

      expect(await actual()).toMatchObject({ phase: 'link_expired', nextAction: 'recover' });
      const recuperada = await llamar(ctrl.recoverEmbeddedSignup, reqDe(tenant, { sessionId }));
      expect(recuperada.status).toBe(200);
      const registroNuevo = await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(tenant, { sessionId }));

      expect(registroNuevo.status).toBe(200);
      expect(registroNuevo.body.data.embedSignupUrl).toBe(`https://gs.tc.im/${appId}`);
      expect(metaEmbeddedSignup.exchangeCode).toHaveBeenCalledTimes(1); // no se repitió el popup de Meta
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(await actual()).toMatchObject({ phase: 'awaiting_gupshup' });
    });

    test('Gupshup falla al registrar: /current ofrece reintentar, el reintento usa la MISMA sesión y el resultado final es una sola app y ningún canal duplicado', async () => {
      partnerApps.createApp.mockRejectedValueOnce(Object.assign(new Error('Gupshup Partner API: error interno del proveedor'), { statusCode: 502 }));
      const { sessionId, registro } = await conectarHastaGupshup();
      expect(registro.status).toBe(502);
      expect(await actual()).toMatchObject({ sessionId, phase: 'registration_failed', nextAction: 'register' });

      const reintento = await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(tenant, { sessionId }));

      expect(reintento.status).toBe(200);
      expect(await ChannelOnboardingSession.countDocuments({ tenantId: tenant._id })).toBe(1);
      expect(appsCreadas).toHaveLength(1);
      expect(await actual()).toMatchObject({ phase: 'awaiting_gupshup' });
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('cupo local del Partner API agotado (429): error recuperable, el reintento posterior completa sin duplicar la app', async () => {
      const cupo = Object.assign(new Error('Cupo local de solicitudes al Partner API de Gupshup agotado — se reintenta más tarde'), { statusCode: 429, code: 'PARTNER_LOCAL_RATE_LIMIT' });
      partnerSubscriptions.subscribeToEvents.mockRejectedValueOnce(cupo);
      const { sessionId, registro } = await conectarHastaGupshup();
      expect(registro.status).toBe(429);
      expect(appsCreadas).toHaveLength(1); // la app ya existía cuando se cortó
      expect((await actual()).nextAction).toBe('register');

      const reintento = await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(tenant, { sessionId }));

      expect(reintento.status).toBe(200);
      expect(appsCreadas).toHaveLength(1); // no se creó otra
    });

    test('el número que Gupshup activó NO es el autorizado: no se conecta nada y el estado pide reiniciar con el número correcto', async () => {
      const { sessionId, registro } = await conectarHastaGupshup();
      const appId = registro.body.data.embedSignupUrl.split('/').pop();
      ponerLive(appId, NUM_B); // la app quedó Live con OTRO número

      const resultado = await verificar(sessionId);

      expect(resultado.body.data.outcome).toBe('mismatch');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      await ChannelOnboardingSession.updateOne({ _id: sessionId }, { $set: { 'reconcile.stoppedAt': new Date(), 'reconcile.stoppedReason': 'mismatch' } });
      expect(await actual()).toMatchObject({ phase: 'needs_attention', nextAction: 'restart', reason: 'number_mismatch' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('aislamiento multi-tenant y ausencia de duplicados', () => {
    test('dos clientes conectan a la vez con números distintos: cada uno obtiene SU app, SU canal y SU credencial; /current de uno nunca ve al otro', async () => {
      const a = await conectarHastaGupshup(tenant, NUM_A);
      const b = await conectarHastaGupshup(otroTenant, NUM_B);
      const appA = a.registro.body.data.embedSignupUrl.split('/').pop();
      const appB = b.registro.body.data.embedSignupUrl.split('/').pop();
      expect(appA).not.toBe(appB);
      expect((await actual(tenant)).sessionId).toBe(a.sessionId);
      expect((await actual(otroTenant)).sessionId).toBe(b.sessionId);

      ponerLive(appA, NUM_A);
      ponerLive(appB, NUM_B);
      await Promise.all([verificar(a.sessionId, tenant), verificar(b.sessionId, otroTenant)]);

      const canalA = await WhatsAppChannel.findOne({ tenantId: tenant._id });
      const canalB = await WhatsAppChannel.findOne({ tenantId: otroTenant._id });
      expect([canalA.providerAppId, canalB.providerAppId]).toEqual([appA, appB]);
      expect([canalA.phoneNumber, canalB.phoneNumber]).toEqual([NUM_A.phone, NUM_B.phone]);
      expect(await WhatsAppChannel.countDocuments({})).toBe(2);
      expect(await ChannelCredentials.countDocuments({})).toBe(2);

      // el mensaje para el número de A solo aterriza en A
      await handleInbound(mensajeEntrante(canalA, 'wamid.A'));
      const evento = await InboundEvent.findOne({ providerMessageId: 'wamid.A' });
      expect(String(evento.tenantId)).toBe(String(tenant._id));
      expect(await InboundEvent.countDocuments({ tenantId: otroTenant._id })).toBe(0);
    });

    test('un tenant no puede verificar ni recuperar la sesión de otro (404) y no la modifica', async () => {
      const { sessionId } = await conectarHastaGupshup();
      const antes = JSON.stringify(await ChannelOnboardingSession.findById(sessionId).lean());

      expect((await verificar(sessionId, otroTenant)).status).toBe(404);
      expect((await llamar(ctrl.recoverEmbeddedSignup, reqDe(otroTenant, { sessionId }))).status).toBe(404);
      expect((await llamar(ctrl.completeGupshupEmbeddedSignup, reqDe(otroTenant, { sessionId }))).status).toBe(404);

      expect(JSON.stringify(await ChannelOnboardingSession.findById(sessionId).lean())).toBe(antes);
    });

    test('dos tenants que intentan conectar el MISMO número: el segundo no activa nada (identity_conflict) y el primero queda intacto', async () => {
      const a = await conectarHastaGupshup(tenant, NUM_A);
      const appA = a.registro.body.data.embedSignupUrl.split('/').pop();
      ponerLive(appA, NUM_A);
      expect((await verificar(a.sessionId, tenant)).body.data.outcome).toBe('completed');
      const canalA = JSON.stringify(await WhatsAppChannel.findOne({ tenantId: tenant._id }).lean());

      const b = await conectarHastaGupshup(otroTenant, NUM_A); // mismo número, otro tenant
      const appB = b.registro.body.data.embedSignupUrl.split('/').pop();
      ponerLive(appB, NUM_A);
      const resultado = await verificar(b.sessionId, otroTenant);

      expect(resultado.body.data.outcome).toBe('identity_conflict');
      expect(await WhatsAppChannel.countDocuments({ tenantId: otroTenant._id })).toBe(0);
      expect(JSON.stringify(await WhatsAppChannel.findOne({ tenantId: tenant._id }).lean())).toBe(canalA);
    });

    test('doble clic en «Conectar»: dos sesiones independientes, pero un único canal al final y reintentar la misma sesión no duplica nada', async () => {
      const primera = await conectarHastaGupshup();
      const segunda = await conectarHastaGupshup();
      const app1 = primera.registro.body.data.embedSignupUrl.split('/').pop();
      const app2 = segunda.registro.body.data.embedSignupUrl.split('/').pop();
      expect(app2).toBe(app1); // la segunda reutiliza la app aún no activada (no hay una app por clic)
      ponerLive(app1, NUM_A);

      await verificar(segunda.sessionId);
      await verificar(segunda.sessionId);
      await verificar(primera.sessionId); // la otra sesión del mismo número: el canal ya existe

      expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id })).toBe(1);
      expect(await ChannelCredentials.countDocuments({})).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('reconexión del mismo número', () => {
    test('el cliente desconecta y vuelve a conectar su número: se reutiliza el canal, hay credenciales activas nuevas y el chat vuelve a ser operativo', async () => {
      // primera conexión
      const primera = await conectarHastaGupshup();
      const app1 = primera.registro.body.data.embedSignupUrl.split('/').pop();
      ponerLive(app1, NUM_A);
      await verificar(primera.sessionId);
      const canal = await WhatsAppChannel.findOne({ tenantId: tenant._id });
      await handleInbound(mensajeEntrante(canal, 'wamid.ANTES'));
      await processInboundJob({ data: { inboundEventId: (await InboundEvent.findOne({ providerMessageId: 'wamid.ANTES' }))._id } });

      // desconexión desde CREA OS
      const desconexion = await llamar(ctrl.disconnectChannel, { ...reqDe(tenant), params: { channelId: String(canal._id) }, user: { _id: new mongoose.Types.ObjectId() } });
      expect(desconexion.status).toBe(200);
      expect((await WhatsAppChannel.findById(canal._id)).status).toBe('disconnected');
      expect((await Conversation.findOne({ business: tenant._id })).whatsappChannelStatus).toBe('reassignment_required');

      // vuelve a conectar el MISMO número (Gupshup lo deja Live en una app nueva)
      vivas = {};
      const segunda = await conectarHastaGupshup();
      const app2 = segunda.registro.body.data.embedSignupUrl.split('/').pop();
      ponerLive(app2, NUM_A);
      const reconexion = await verificar(segunda.sessionId);

      expect(reconexion.error?.message).toBeUndefined();
      expect(reconexion.body.data.outcome).toBe('completed');
      expect(await WhatsAppChannel.countDocuments({ tenantId: tenant._id })).toBe(1);
      const reutilizado = await WhatsAppChannel.findById(canal._id);
      expect(reutilizado).toMatchObject({ status: 'active', outboundApi: 'partner', providerAppId: app2 });
      expect((await channelCredentialsService.resolveCredentials(reutilizado)).apiKey).toBe(`apikey-de-${app2}`);
      expect((await Conversation.findOne({ business: tenant._id })).whatsappChannelStatus).toBe('ready');

      // y vuelve a recibir mensajes
      await handleInbound(mensajeEntrante(reutilizado, 'wamid.DESPUES'));
      expect(await InboundEvent.countDocuments({ providerMessageId: 'wamid.DESPUES', tenantId: tenant._id })).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('contrato con el frontend', () => {
    test('/current responde { onboarding: null } sin nada en curso y nunca expone secretos', async () => {
      const vacio = await llamar(ctrl.getCurrentEmbeddedSignup, reqDe(tenant));
      expect(vacio.body.data).toEqual({ onboarding: null });

      await conectarHastaGupshup();
      const conectando = await llamar(ctrl.getCurrentEmbeddedSignup, reqDe(tenant));
      expect(JSON.stringify(conectando.body)).not.toMatch(/accessTokenCipher|token-meta|apikey|partner-token/i);
    });

    test('recover valida la entrada: sessionId requerido (400), inválido (400) y una sesión demasiado antigua no se reabre (409)', async () => {
      expect((await llamar(ctrl.recoverEmbeddedSignup, reqDe(tenant, {}))).status).toBe(400);
      expect((await llamar(ctrl.recoverEmbeddedSignup, reqDe(tenant, { sessionId: 'no-es-un-id' }))).status).toBe(400);

      const { sessionId } = await conectarHastaGupshup();
      await ChannelOnboardingSession.collection.updateOne({ _id: new mongoose.Types.ObjectId(sessionId) }, { $set: { createdAt: new Date(Date.now() - 8 * DIA) } });
      const vieja = await llamar(ctrl.recoverEmbeddedSignup, reqDe(tenant, { sessionId }));
      expect(vieja.status).toBe(409);
      expect(vieja.error.message).toMatch(/demasiado antigua/);
    });
  });
});
