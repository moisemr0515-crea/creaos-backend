// E2E (Jest, Mongo real en base propia, Gupshup/Meta SIMULADOS) de la habilitación AUTOMÁTICA del modo enlace único para
// negocios nuevos (sin configurar ningún tenantId por cliente), conservando el flujo clásico de los negocios existentes.
// El negocio y su dueño se crean con el REGISTRO REAL (auth.service#registrar); los permisos y la capacidad de plan se
// comprueban con los middlewares reales de las rutas. Nunca se usan números reales ni se llama a Gupshup.
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');
process.env.BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'https://backend.creaos.test';
process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN = process.env.GUPSHUP_ONBOARDING_WEBHOOK_TOKEN || 'onboarding-webhook-token-de-prueba';
process.env.GUPSHUP_WEBHOOK_TOKEN = process.env.GUPSHUP_WEBHOOK_TOKEN || 'webhook-token-de-prueba';

jest.mock('./providers/meta/metaEmbeddedSignup.service');
jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');
jest.mock('./providers/gupshup/partner/partner.subscriptions');
jest.mock('./standardTemplate.service');
jest.mock('../../utils/email', () => ({
  enviarEmailVerificacion: jest.fn().mockResolvedValue(undefined),
  enviarEmailResetPassword: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../config/redis', () => ({ getRedis: () => ({ setex: jest.fn().mockResolvedValue('OK') }) }));

const mongoose = require('mongoose');
const env = require('../../config/env');
const { ROLES, ROLE_PERMISSIONS, PERMISSIONS } = require('../../config/constants');
const { CURRENT_LEGAL_VERSIONS } = require('../../config/legalDocuments');
const Business = require('../businesses/business.model');
const Role = require('../roles/role.model');
const User = require('../users/user.model');
const Plan = require('../subscriptions/plan.model');
const Subscription = require('../subscriptions/subscription.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const ChannelCredentials = require('./channelCredentials.model');
const metaEmbeddedSignup = require('./providers/meta/metaEmbeddedSignup.service');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const standardTemplateService = require('./standardTemplate.service');
const { checkPermission } = require('../../middleware/rbac.middleware');
const { requireCapability } = require('../../middleware/entitlement.middleware');
const { registrar } = require('../auth/auth.service');
const { handleGupshupAccountVerified } = require('./channelOnboardingCompletion.service');
const ctrl = require('./channel.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_link_mode_new_tenants';
const DIA = 24 * 60 * 60 * 1000;
const TEL = '+51900000501';
const NUM = { raw: '51900000501', waba: '1000000000000501', pnid: '1000000000000701' };
const MODELOS = [ChannelCredentials, WhatsAppChannel, ChannelOnboardingSession, Subscription, User, Business];
const ACEPTACION = { termsAccepted: true, privacyAccepted: true, ...CURRENT_LEGAL_VERSIONS };

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
// Ejecuta un middleware real de ruta y devuelve el error (o null si deja pasar).
const middleware = async (mw, req) => {
  const next = jest.fn();
  await mw(req, mockRes(), next);
  return next.mock.calls[0]?.[0] || null;
};

describe('E2E modo enlace único — habilitación automática de negocios nuevos', () => {
  let vivas;
  let contador = 0;

  // Registro REAL: crea el negocio y su dueño (rol Owner) y devuelve lo que `authenticate` + `injectTenant` pondrían en req.
  async function registrarNegocio(nombre) {
    contador += 1;
    jest.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: jest.fn().mockRejectedValue(new Error('Transaction numbers are only allowed on a replica set member')),
      endSession: jest.fn().mockResolvedValue(undefined),
    });
    const { usuario } = await registrar({
      name: `Dueño ${nombre}`, email: `dueno${contador}@negocio.test`, password: 'Password1', businessName: nombre, legalAcceptance: ACEPTACION,
    });
    jest.restoreAllMocks();
    const user = await User.findById(usuario._id).populate('role', 'slug permissions');
    return { businessId: user.business, user, body: {} };
  }
  const reqDe = (cliente, body = {}) => ({ ...cliente, body });
  const modoDe = async (cliente) => (await llamar(ctrl.getOnboardingMode, reqDe(cliente))).body.data.mode;
  const conectar = (cliente, phoneNumber = TEL, extra = {}) => llamar(ctrl.startLinkOnboarding, reqDe(cliente, { phoneNumber, ...extra }));
  const actual = async (cliente) => (await llamar(ctrl.getCurrentEmbeddedSignup, reqDe(cliente))).body.data.onboarding;
  const verificar = (cliente, sessionId) => llamar(ctrl.reconcileEmbeddedSignup, reqDe(cliente, { sessionId }));
  const ponerLive = (appId, over = {}) => { vivas[appId] = { phone: NUM.raw, phoneId: NUM.pnid, wabaId: NUM.waba, accountStatus: 'ACTIVE', ...over }; };
  const antiguo = async (cliente, dias = 3) => { // negocio EXISTENTE: se retrocede su fecha de registro
    await Business.collection.updateOne({ _id: cliente.businessId }, { $set: { createdAt: new Date(Date.now() - dias * DIA) } });
  };
  const sinLlamadasAGupshup = () => {
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
    expect(partnerApps.createApp).not.toHaveBeenCalled();
    expect(partnerApps.getEmbedSignupLink).not.toHaveBeenCalled();
  };
  const entorno = { enabled: env.ONBOARDING_LINK_MODE_ENABLED, tenants: env.ONBOARDING_LINK_MODE_TENANTS, from: env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Role.deleteMany({});
    await Plan.deleteMany({});
    await Role.create({ name: 'Owner', slug: ROLES.OWNER, business: null, isSystem: true, permissions: ROLE_PERMISSIONS[ROLES.OWNER] });
    // Plan Starter como en el seed de producción: WhatsApp incluido (todo negocio nuevo nace en este plan).
    await Plan.create({ name: 'starter', displayName: 'Starter', price: 0, currency: 'USD', interval: 'month', isActive: true, limits: { leadsPerMonth: 20, aiEnabled: true, automationsEnabled: true, maxActiveAutomations: 20, whatsappEnabled: true, multiUser: false, maxUsers: 1, advancedReports: false } });
  });
  afterAll(async () => {
    for (const m of [...MODELOS, Role, Plan]) await m.deleteMany({});
    await mongoose.disconnect();
    Object.assign(env, { ONBOARDING_LINK_MODE_ENABLED: entorno.enabled, ONBOARDING_LINK_MODE_TENANTS: entorno.tenants, ONBOARDING_LINK_MODE_NEW_TENANTS_FROM: entorno.from });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    for (const m of MODELOS) await m.deleteMany({});
    // Producción tras activar: interruptor global ON, fecha de corte = hace 1 minuto, SIN lista de negocios.
    Object.assign(env, { ONBOARDING_LINK_MODE_ENABLED: true, ONBOARDING_LINK_MODE_TENANTS: [], ONBOARDING_LINK_MODE_NEW_TENANTS_FROM: new Date(Date.now() - 60 * 1000) });
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
  });

  test('NEGOCIO NUEVO (registro real, sin lista): modo automático, permisos y plan OK, conecta de punta a punta y se activa con el estado real de Gupshup', async () => {
    const cliente = await registrarNegocio('Panadería Nueva');

    // lo que exigen las rutas: permiso del dueño y capacidad de WhatsApp del plan (middlewares reales)
    expect(cliente.user.role.permissions).toContain(PERMISSIONS.BUSINESSES_SETTINGS);
    expect(await middleware(checkPermission(PERMISSIONS.BUSINESSES_SETTINGS), cliente)).toBeNull();
    expect(await middleware(requireCapability('whatsappEnabled'), cliente)).toBeNull();

    expect(env.ONBOARDING_LINK_MODE_TENANTS).toEqual([]); // nadie configuró ningún tenantId
    expect(await modoDe(cliente)).toBe('gupshup_link');

    // una solicitud con un tenant AJENO en el cuerpo se ignora: el negocio sale siempre del token
    const ajeno = new mongoose.Types.ObjectId().toString();
    const inicio = await conectar(cliente, TEL, { tenantId: ajeno, businessId: ajeno });
    expect(inicio.status).toBe(200);
    const { sessionId, embedSignupUrl } = inicio.body.data;
    const sesion = await ChannelOnboardingSession.findById(sessionId).lean();
    expect(String(sesion.tenantId)).toBe(String(cliente.businessId));
    expect(sesion).toMatchObject({ mode: 'gupshup_link', declaredPhone: TEL });
    expect(await ChannelOnboardingSession.countDocuments({ tenantId: ajeno })).toBe(0);

    // estado real: pendiente mientras el cliente no completa la ventana de Gupshup
    expect((await verificar(cliente, sessionId)).body.data.outcome).toBe('pending');
    expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    expect(await actual(cliente)).toMatchObject({ phase: 'awaiting_gupshup', mode: 'gupshup_link', embedSignupUrl });

    // el cliente completa la ventana con su número → Gupshup informa la app Live → canal activo, sin pasos administrativos
    ponerLive(embedSignupUrl.split('/').pop());
    expect((await verificar(cliente, sessionId)).body.data.outcome).toBe('completed');
    const canal = await WhatsAppChannel.findOne({});
    expect(canal).toMatchObject({ status: 'active', phoneNumber: TEL, connectionType: 'DEDICATED', outboundApi: 'partner' });
    expect(String(canal.tenantId)).toBe(String(cliente.businessId));
    expect(await actual(cliente)).toBeNull();
    expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled(); // una sola autorización: la del enlace de Gupshup
  });

  test('NEGOCIO EXISTENTE (anterior a la fecha, sin estar en la lista): conserva el flujo clásico; /start responde 404 y no llama a Gupshup', async () => {
    const existente = await registrarNegocio('Negocio Antiguo');
    await antiguo(existente);

    expect(await modoDe(existente)).toBe('meta_then_link');
    const r = await conectar(existente);
    expect(r.status).toBe(404);
    expect(await ChannelOnboardingSession.countDocuments({})).toBe(0);
    sinLlamadasAGupshup();
  });

  test('la lista explícita habilita a un negocio existente concreto; los demás existentes siguen en el flujo clásico', async () => {
    const piloto = await registrarNegocio('Piloto Antiguo');
    const otro = await registrarNegocio('Otro Antiguo');
    await antiguo(piloto);
    await antiguo(otro);
    env.ONBOARDING_LINK_MODE_TENANTS = [String(piloto.businessId)];

    expect(await modoDe(piloto)).toBe('gupshup_link');
    expect(await modoDe(otro)).toBe('meta_then_link');
    expect((await conectar(otro)).status).toBe(404);
  });

  test('INTERRUPTOR GLOBAL APAGADO: ningún negocio (ni nuevo ni de la lista) usa el modo; una conexión ya iniciada se completa igual', async () => {
    const cliente = await registrarNegocio('Negocio En Curso');
    const inicio = await conectar(cliente);
    const appId = inicio.body.data.embedSignupUrl.split('/').pop();

    env.ONBOARDING_LINK_MODE_ENABLED = false; // parada de emergencia
    env.ONBOARDING_LINK_MODE_TENANTS = [String(cliente.businessId)];
    const nuevo = await registrarNegocio('Negocio Posterior');
    expect(await modoDe(cliente)).toBe('meta_then_link');
    expect(await modoDe(nuevo)).toBe('meta_then_link');
    expect((await conectar(nuevo)).status).toBe(404);

    // la sesión que ya estaba en curso no se pierde: el webhook/conciliación no dependen del interruptor
    ponerLive(appId);
    await handleGupshupAccountVerified(appId);
    expect(await WhatsAppChannel.countDocuments({ tenantId: cliente.businessId, status: 'active' })).toBe(1);
  });

  test('fecha de corte vacía o inválida: ningún negocio se habilita por antigüedad (falla cerrado)', async () => {
    const valores = ['', '   ', 'no-es-una-fecha', '2026-13-45'];
    for (const valor of valores) {
      jest.isolateModules(() => {
        const previo = process.env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM;
        process.env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM = valor;
        expect(require('../../config/env').ONBOARDING_LINK_MODE_NEW_TENANTS_FROM).toBeNull();
        if (previo === undefined) delete process.env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM; else process.env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM = previo;
      });
    }
    jest.isolateModules(() => {
      process.env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM = '2026-10-20T00:00:00Z';
      expect(require('../../config/env').ONBOARDING_LINK_MODE_NEW_TENANTS_FROM.toISOString()).toBe('2026-10-20T00:00:00.000Z');
      delete process.env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM;
    });
    env.ONBOARDING_LINK_MODE_NEW_TENANTS_FROM = null;
    const cliente = await registrarNegocio('Sin Fecha');
    expect(await modoDe(cliente)).toBe('meta_then_link');
  });

  test('dos negocios nuevos: aislamiento estricto (sesiones y apps separadas; el número ya activado en uno no se activa en el otro)', async () => {
    const a = await registrarNegocio('Negocio Uno');
    const b = await registrarNegocio('Negocio Dos');
    const ia = await conectar(a);
    const ib = await conectar(b);
    expect(ib.body.data.sessionId).not.toBe(ia.body.data.sessionId);
    const appA = ia.body.data.embedSignupUrl.split('/').pop();
    const appB = ib.body.data.embedSignupUrl.split('/').pop();
    expect(appA).not.toBe(appB);
    expect(await actual(a)).toMatchObject({ sessionId: ia.body.data.sessionId });
    expect(await actual(b)).toMatchObject({ sessionId: ib.body.data.sessionId });
    expect((await verificar(b, ia.body.data.sessionId)).status).toBe(404); // no puede conciliar la sesión del otro

    ponerLive(appA);
    expect((await verificar(a, ia.body.data.sessionId)).body.data.outcome).toBe('completed');
    // el otro negocio intenta con el mismo número: Gupshup lo informaría Live en su app → conflicto de identidad, nada se activa
    ponerLive(appB);
    expect((await verificar(b, ib.body.data.sessionId)).body.data.outcome).toBe('identity_conflict');
    expect(await WhatsAppChannel.countDocuments({ tenantId: b.businessId })).toBe(0);
    expect(await WhatsAppChannel.countDocuments({})).toBe(1);
  });

  describe('errores de Gupshup: nunca «conectado» falso y recuperación sin duplicar aplicaciones', () => {
    test('falla al crear la app: sin canal, el estado ofrece reintentar y el reintento crea UNA sola app', async () => {
      const cliente = await registrarNegocio('Reintento Uno');
      partnerApps.createApp.mockRejectedValueOnce(Object.assign(new Error('Gupshup Partner API: error interno del proveedor'), { statusCode: 502 }));

      const fallo = await conectar(cliente);
      expect(fallo.status).toBe(502);
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      expect(await actual(cliente)).toMatchObject({ phase: 'registration_failed', nextAction: 'register' });

      const ok = await conectar(cliente);
      expect(ok.status).toBe(200);
      expect(ok.body.data.onboarding).toMatchObject({ phase: 'awaiting_gupshup', nextAction: 'open_link' });
      expect(partnerApps.createApp).toHaveBeenCalledTimes(2); // 1 fallida + 1 exitosa: una sola app existe en Gupshup
      expect(await ChannelOnboardingSession.countDocuments({ tenantId: cliente.businessId })).toBe(1);
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });

    test('falla DESPUÉS de crear la app (suscripción): el reintento reutiliza la misma app', async () => {
      const cliente = await registrarNegocio('Reintento Dos');
      partnerSubscriptions.subscribeToEvents.mockRejectedValueOnce(Object.assign(new Error('Gupshup Partner API: error interno del proveedor'), { statusCode: 502 }));
      expect((await conectar(cliente)).status).toBe(502);
      const appId = (await ChannelOnboardingSession.findOne({ tenantId: cliente.businessId }).lean()).gupshup.appId;
      expect(appId).toBeTruthy();

      const ok = await conectar(cliente);
      expect(ok.status).toBe(200);
      expect(partnerApps.createApp).toHaveBeenCalledTimes(1);
      expect(ok.body.data.embedSignupUrl).toBe(`https://gs.tc.im/${appId}`);
    });

    test('Gupshup falla al consultar el estado (5xx): la conciliación informa el error, NO activa nada y se puede reintentar', async () => {
      const cliente = await registrarNegocio('Estado Caido');
      const inicio = await conectar(cliente);
      const { sessionId, embedSignupUrl } = inicio.body.data;
      const appId = embedSignupUrl.split('/').pop();
      partnerApps.getWabaInfo.mockRejectedValueOnce(Object.assign(new Error('Gupshup Partner API: error interno del proveedor'), { statusCode: 502 }));

      const r = await verificar(cliente, sessionId);
      expect(r.body.data.outcome).toBe('error');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
      expect((await ChannelOnboardingSession.findById(sessionId).lean()).status).toBe('gupshup_registering');

      ponerLive(appId);
      expect((await verificar(cliente, sessionId)).body.data.outcome).toBe('completed');
    });

    test('una app con información incompleta o no activa nunca activa el canal', async () => {
      const cliente = await registrarNegocio('No Activa');
      const { sessionId, embedSignupUrl } = (await conectar(cliente)).body.data;
      const appId = embedSignupUrl.split('/').pop();

      ponerLive(appId, { accountStatus: 'PENDING' });
      expect((await verificar(cliente, sessionId)).body.data).toMatchObject({ outcome: 'pending', reason: 'estado_no_activo' });
      ponerLive(appId, { phone: undefined });
      expect((await verificar(cliente, sessionId)).body.data.outcome).toBe('pending');
      expect(await WhatsAppChannel.countDocuments({})).toBe(0);
    });
  });
});
