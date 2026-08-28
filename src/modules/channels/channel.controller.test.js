// Test real (Jest, commiteado) de channel.controller.js#initEmbeddedSignup()
// — PR-03 del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §19-20).
//
// Se invoca el controller directamente con req/res mockeados (mismo patrón
// que admin.controller.inviteUser.test.js), contra Mongo real, en una base
// propia de este archivo.
//
// META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID se vacía ANTES de requerir
// config/env.js (misma razón que partner.auth.test.js: dotenv.config() no
// pisa una key que ya existe en process.env, aunque esté vacía — así el
// escenario "sin configurar" es determinístico sin importar el .env local
// de quien corra el test).
process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = '';
process.env.META_APP_ID = process.env.META_APP_ID || 'meta-app-id-de-prueba';

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const logger = require('../../utils/logger');
const { initEmbeddedSignup } = require('./channel.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_controller';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('channel.controller#initEmbeddedSignup()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await ChannelOnboardingSession.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('creación exitosa sin displayName: 201, crea la sesión, devuelve exactamente los 4 campos documentados', async () => {
    const req = { businessId: business._id, body: {} };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.message).toBe('Sesión de onboarding de WhatsApp iniciada');
    expect(Object.keys(body.data).sort()).toEqual(['expiresAt', 'metaConfig', 'sessionId', 'state']);

    const session = await ChannelOnboardingSession.findById(body.data.sessionId);
    expect(session).not.toBeNull();
    expect(session.tenantId.toString()).toBe(business._id.toString());
    expect(session.status).toBe('initiated');
    expect(session.provider).toBe('gupshup');
    expect(session.state).toBe(body.data.state);
    expect(session.displayName).toBeNull();
  });

  test('creación exitosa con displayName: se trimea y se persiste en la sesión', async () => {
    const req = { businessId: business._id, body: { displayName: '  Línea de ventas  ' } };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];

    const session = await ChannelOnboardingSession.findById(body.data.sessionId);
    expect(session.displayName).toBe('Línea de ventas');
  });

  test('displayName que no es string: 400 vía next(err), no crea ninguna sesión', async () => {
    const req = { businessId: business._id, body: { displayName: 12345 } };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(res.status).not.toHaveBeenCalled();
    expect(await ChannelOnboardingSession.countDocuments({})).toBe(0);
  });

  test('displayName de más de 100 caracteres: 400 vía next(err), no crea ninguna sesión', async () => {
    const req = { businessId: business._id, body: { displayName: 'x'.repeat(101) } };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(await ChannelOnboardingSession.countDocuments({})).toBe(0);
  });

  test('displayName de exactamente 100 caracteres: se acepta (límite inclusive)', async () => {
    const nombreLimite = 'x'.repeat(100);
    const req = { businessId: business._id, body: { displayName: nombreLimite } };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('displayName solo espacios: se trata como si no hubiera venido (sesión con displayName null)', async () => {
    const req = { businessId: business._id, body: { displayName: '   ' } };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    const session = await ChannelOnboardingSession.findById(body.data.sessionId);
    expect(session.displayName).toBeNull();
  });

  test('body ausente del todo (req.body undefined): no explota, crea la sesión igual', async () => {
    const req = { businessId: business._id };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('sesión concurrente NO bloqueada: 2 sesiones sin terminar para el mismo tenant, ambas se crean, solo se loguea info', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const req1 = { businessId: business._id, body: {} };
    const res1 = mockRes();
    await initEmbeddedSignup(req1, res1, jest.fn());

    const req2 = { businessId: business._id, body: {} };
    const res2 = mockRes();
    await initEmbeddedSignup(req2, res2, jest.fn());

    // Ambas se crearon — la segunda NO fue bloqueada por la primera.
    expect(res1.status).toHaveBeenCalledWith(201);
    expect(res2.status).toHaveBeenCalledWith(201);
    expect(await ChannelOnboardingSession.countDocuments({ tenantId: business._id })).toBe(2);

    // La segunda llamada debe haber logueado la sesión previa sin terminar
    // como INFO — nunca warn/error, eso confirmaría que no se trata como problema.
    expect(infoSpy).toHaveBeenCalledWith(
      '[channel.controller] Tenant con sesión(es) de onboarding sin terminar — se permite igual, concurrente',
      expect.objectContaining({ tenantId: business._id.toString(), sesionesSinTerminar: 1 })
    );
    // Ningún warn.* de "sesión sin terminar" — el único warn esperable en
    // este archivo es el de META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID ausente.
    const warnCalls = warnSpy.mock.calls.map(([msg]) => msg);
    expect(warnCalls.every((msg) => msg.includes('META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID'))).toBe(true);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('la respuesta NUNCA expone tokens/secrets/datos de ChannelCredentials', async () => {
    const req = { businessId: business._id, body: { displayName: 'Canal sensible' } };
    const res = mockRes();
    await initEmbeddedSignup(req, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    const serializado = JSON.stringify(body);

    // Ni el shape completo del documento (meta.*, gupshup.*, error.*,
    // accessTokenCipher, channel) ni ningún nombre de campo sensible deben
    // aparecer en la respuesta HTTP bajo ningún concepto.
    expect(body.data).not.toHaveProperty('meta');
    expect(body.data).not.toHaveProperty('gupshup');
    expect(body.data).not.toHaveProperty('channel');
    expect(body.data).not.toHaveProperty('displayName');
    expect(serializado).not.toMatch(/accessTokenCipher|ciphertext|apiKey|client_secret|clientSecret|appToken/i);
  });

  test('sin META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: metaConfig.configId viaja null, se loguea warning, la sesión se crea igual (201)', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const req = { businessId: business._id, body: {} };
    const res = mockRes();
    const next = jest.fn();

    await initEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);

    const body = res.json.mock.calls[0][0];
    expect(body.data.metaConfig.configId).toBeNull();
    expect(body.data.metaConfig.appId).toBe(process.env.META_APP_ID);

    expect(warnSpy).toHaveBeenCalledWith(
      '[channel.controller] META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID no configurado — metaConfig.configId viaja null',
      expect.objectContaining({ sessionId: body.data.sessionId.toString() })
    );

    warnSpy.mockRestore();
  });
});
