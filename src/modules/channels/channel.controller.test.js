// Test real (Jest, commiteado) de channel.controller.js — PR-03
// (initEmbeddedSignup) + PR-04 (codeEmbeddedSignup/callbackEmbeddedSignup)
// + PR-05 (completeGupshupEmbeddedSignup) del blueprint maestro
// (CREA_OS_WhatsApp_Gupshup_Multitenant_Architecture_v1.md §19-22, §55).
//
// Se invoca el controller directamente con req/res mockeados (mismo patrón
// que admin.controller.inviteUser.test.js), contra Mongo real, en una base
// propia de este archivo. metaEmbeddedSignup.service.js y los módulos del
// wrapper de Gupshup Partner (partner.auth/partner.apps) se mockean enteros
// (jest.mock) — nunca pegan contra Meta/Gupshup real; ya tienen sus propios
// tests aislados.
//
// META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID se vacía y CHANNEL_CREDENTIALS_KEY
// se genera ANTES de requerir config/env.js/channelCrypto.js (misma razón
// que partner.auth.test.js: dotenv.config() no pisa una key que ya existe
// en process.env, aunque esté vacía — así el escenario "sin configurar" es
// determinístico sin importar el .env local de quien corra el test).
process.env.META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = '';
process.env.META_APP_ID = process.env.META_APP_ID || 'meta-app-id-de-prueba';
process.env.CHANNEL_CREDENTIALS_KEY = process.env.CHANNEL_CREDENTIALS_KEY || require('crypto').randomBytes(32).toString('hex');
// PR-06: completeGupshupEmbeddedSignup() ahora también se suscribe a eventos
// ACCOUNT (necesita BACKEND_PUBLIC_URL configurado) — mismo motivo que las
// otras env vars de acá arriba, seteada ANTES de requerir config/env.js.
process.env.BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'https://backend.creaos.test';

jest.mock('./providers/meta/metaEmbeddedSignup.service');
jest.mock('./providers/gupshup/partner/partner.auth');
jest.mock('./providers/gupshup/partner/partner.apps');
jest.mock('./providers/gupshup/partner/partner.subscriptions');

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const channelCrypto = require('./channelCrypto');
const logger = require('../../utils/logger');
const metaEmbeddedSignup = require('./providers/meta/metaEmbeddedSignup.service');
const partnerAuth = require('./providers/gupshup/partner/partner.auth');
const partnerApps = require('./providers/gupshup/partner/partner.apps');
const partnerSubscriptions = require('./providers/gupshup/partner/partner.subscriptions');
const {
  initEmbeddedSignup,
  codeEmbeddedSignup,
  callbackEmbeddedSignup,
  completeGupshupEmbeddedSignup,
} = require('./channel.controller');

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

describe('channel.controller#codeEmbeddedSignup() / #callbackEmbeddedSignup()', () => {
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
    jest.clearAllMocks();
  });

  // Helper — crea una sesión ya en 'initiated' (equivalente a lo que deja init()).
  function crearSesionInitiated(overrides = {}) {
    return ChannelOnboardingSession.create({ tenantId: business._id, ...overrides });
  }

  // Helper — crea una sesión ya en 'meta_authorized', con un token cifrado
  // real (mismo mecanismo que usaría codeEmbeddedSignup()), para probar
  // callbackEmbeddedSignup() en aislamiento.
  async function crearSesionMetaAuthorized(overrides = {}) {
    const session = await crearSesionInitiated(overrides);
    session.meta.accessTokenCipher = channelCrypto.encrypt('token-de-meta-de-prueba', `onboarding:${session._id}`);
    session.status = 'meta_authorized';
    await session.save();
    return session;
  }

  describe('codeEmbeddedSignup()', () => {
    test('happy path: 200, transiciona a meta_authorized, guarda el token cifrado (nunca en texto plano)', async () => {
      const session = await crearSesionInitiated();
      metaEmbeddedSignup.exchangeCode.mockResolvedValue('token-real-de-meta');

      const req = { businessId: business._id, body: { sessionId: String(session._id), code: 'code-real' } };
      const res = mockRes();
      const next = jest.fn();

      await codeEmbeddedSignup(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body.data).sort()).toEqual(['expiresAt', 'sessionId', 'state']);

      const refrescada = await ChannelOnboardingSession.findById(session._id);
      expect(refrescada.status).toBe('meta_authorized');
      expect(refrescada.meta.accessTokenCipher.ciphertext).toBeTruthy();
      const descifrado = channelCrypto.decrypt(refrescada.meta.accessTokenCipher, `onboarding:${session._id}`);
      expect(descifrado).toBe('token-real-de-meta');

      // Nunca el token, ni cifrado, en la respuesta HTTP.
      const serializado = JSON.stringify(body);
      expect(serializado).not.toMatch(/token-real-de-meta|ciphertext|accessTokenCipher/i);
    });

    test('sessionId inexistente: 404, no llama a exchangeCode', async () => {
      const req = { businessId: business._id, body: { sessionId: new mongoose.Types.ObjectId().toString(), code: 'code-x' } };
      const res = mockRes();
      const next = jest.fn();

      await codeEmbeddedSignup(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled();
    });

    test('aislamiento: sesión de OTRO tenant devuelve 404, no 403 ni datos', async () => {
      const otroNegocio = await Business.create({ name: 'Otro negocio' });
      const sesionAjena = await crearSesionInitiated({ tenantId: otroNegocio._id });

      const req = { businessId: business._id, body: { sessionId: String(sesionAjena._id), code: 'code-x' } };
      const res = mockRes();
      const next = jest.fn();

      await codeEmbeddedSignup(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled();
    });

    test('sesión expirada: transiciona a expired y devuelve 409 INVALID_SESSION_STATE', async () => {
      const session = await crearSesionInitiated();
      await ChannelOnboardingSession.updateOne({ _id: session._id }, { expiresAt: new Date(Date.now() - 1000) });

      const req = { businessId: business._id, body: { sessionId: String(session._id), code: 'code-x' } };
      const res = mockRes();
      const next = jest.fn();

      await codeEmbeddedSignup(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(409);
      const body = res.json.mock.calls[0][0];
      expect(body).toEqual({
        success: false,
        message: expect.any(String),
        errors: { code: 'INVALID_SESSION_STATE', currentState: 'expired' },
      });

      const refrescada = await ChannelOnboardingSession.findById(session._id);
      expect(refrescada.status).toBe('expired');
    });

    test('estado incorrecto (ya avanzó a meta_authorized): 409 INVALID_SESSION_STATE con currentState real', async () => {
      const session = await crearSesionMetaAuthorized();

      const req = { businessId: business._id, body: { sessionId: String(session._id), code: 'code-x' } };
      const res = mockRes();
      const next = jest.fn();

      await codeEmbeddedSignup(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = res.json.mock.calls[0][0];
      expect(body.errors).toEqual({ code: 'INVALID_SESSION_STATE', currentState: 'meta_authorized' });
      expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled();
    });

    test('error de Meta al canjear el code: se propaga, la sesión queda failed con error.step:"meta_auth"', async () => {
      const session = await crearSesionInitiated();
      const errorDeMeta = Object.assign(new Error('Invalid verification code format.'), { statusCode: 502 });
      metaEmbeddedSignup.exchangeCode.mockRejectedValue(errorDeMeta);

      const req = { businessId: business._id, body: { sessionId: String(session._id), code: 'code-vencido' } };
      const res = mockRes();
      const next = jest.fn();

      await codeEmbeddedSignup(req, res, next);

      expect(next).toHaveBeenCalledWith(errorDeMeta);
      expect(res.status).not.toHaveBeenCalled();

      const refrescada = await ChannelOnboardingSession.findById(session._id);
      expect(refrescada.status).toBe('failed');
      expect(refrescada.error.step).toBe('meta_auth');
      expect(refrescada.error.message).toBe('Invalid verification code format.');
    });

    test('sessionId/code faltantes: 400, no toca Mongo ni llama a Meta', async () => {
      const res1 = mockRes();
      const next1 = jest.fn();
      await codeEmbeddedSignup({ businessId: business._id, body: { code: 'x' } }, res1, next1);
      expect(next1).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));

      const res2 = mockRes();
      const next2 = jest.fn();
      await codeEmbeddedSignup({ businessId: business._id, body: { sessionId: new mongoose.Types.ObjectId().toString() } }, res2, next2);
      expect(next2).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));

      expect(metaEmbeddedSignup.exchangeCode).not.toHaveBeenCalled();
    });
  });

  describe('callbackEmbeddedSignup()', () => {
    test('happy path: 200, transiciona a gupshup_registering, guarda wabaId/phoneNumberId/phoneNumber', async () => {
      const session = await crearSesionMetaAuthorized();
      metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: '+16315555556', verifiedName: 'CREA OS' });

      const req = { businessId: business._id, body: { sessionId: String(session._id), wabaId: 'waba-real', phoneNumberId: 'pnid-real' } };
      const res = mockRes();
      const next = jest.fn();

      await callbackEmbeddedSignup(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body.data).sort()).toEqual(['expiresAt', 'sessionId', 'state']);

      expect(metaEmbeddedSignup.resolvePhoneNumber).toHaveBeenCalledWith('waba-real', 'pnid-real', 'token-de-meta-de-prueba');

      const refrescada = await ChannelOnboardingSession.findById(session._id);
      expect(refrescada.status).toBe('gupshup_registering');
      expect(refrescada.meta.wabaId).toBe('waba-real');
      expect(refrescada.meta.phoneNumberId).toBe('pnid-real');
      expect(refrescada.meta.phoneNumber).toBe('+16315555556');

      const serializado = JSON.stringify(body);
      expect(serializado).not.toMatch(/token-de-meta-de-prueba|ciphertext|accessTokenCipher/i);
    });

    test('sessionId inexistente: 404, no llama a resolvePhoneNumber', async () => {
      const req = { businessId: business._id, body: { sessionId: new mongoose.Types.ObjectId().toString(), wabaId: 'w', phoneNumberId: 'p' } };
      const res = mockRes();
      const next = jest.fn();

      await callbackEmbeddedSignup(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(metaEmbeddedSignup.resolvePhoneNumber).not.toHaveBeenCalled();
    });

    test('aislamiento: sesión de OTRO tenant devuelve 404', async () => {
      const otroNegocio = await Business.create({ name: 'Otro negocio' });
      const sesionAjena = await crearSesionMetaAuthorized({ tenantId: otroNegocio._id });

      const req = { businessId: business._id, body: { sessionId: String(sesionAjena._id), wabaId: 'w', phoneNumberId: 'p' } };
      const res = mockRes();
      const next = jest.fn();

      await callbackEmbeddedSignup(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(metaEmbeddedSignup.resolvePhoneNumber).not.toHaveBeenCalled();
    });

    test('sesión expirada (ventana de 30 min desde init, no desde meta_authorized): 409 INVALID_SESSION_STATE currentState:"expired"', async () => {
      const session = await crearSesionMetaAuthorized();
      await ChannelOnboardingSession.updateOne({ _id: session._id }, { expiresAt: new Date(Date.now() - 1000) });

      const req = { businessId: business._id, body: { sessionId: String(session._id), wabaId: 'w', phoneNumberId: 'p' } };
      const res = mockRes();
      const next = jest.fn();

      await callbackEmbeddedSignup(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = res.json.mock.calls[0][0];
      expect(body.errors).toEqual({ code: 'INVALID_SESSION_STATE', currentState: 'expired' });
    });

    test('estado incorrecto (todavía en initiated, falta /code): 409 INVALID_SESSION_STATE currentState:"initiated"', async () => {
      const session = await crearSesionInitiated();

      const req = { businessId: business._id, body: { sessionId: String(session._id), wabaId: 'w', phoneNumberId: 'p' } };
      const res = mockRes();
      const next = jest.fn();

      await callbackEmbeddedSignup(req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = res.json.mock.calls[0][0];
      expect(body.errors).toEqual({ code: 'INVALID_SESSION_STATE', currentState: 'initiated' });
      expect(body.message).toMatch(/code/);
      expect(metaEmbeddedSignup.resolvePhoneNumber).not.toHaveBeenCalled();
    });

    test('phoneNumberId no encontrado en la respuesta de Meta: se propaga, la sesión queda failed con error.step:"phone_resolution"', async () => {
      const session = await crearSesionMetaAuthorized();
      const errorDeMeta = Object.assign(new Error('phoneNumberId "pnid-x" no encontrado entre los números de la WABA "waba-real"'), { statusCode: 502 });
      metaEmbeddedSignup.resolvePhoneNumber.mockRejectedValue(errorDeMeta);

      const req = { businessId: business._id, body: { sessionId: String(session._id), wabaId: 'waba-real', phoneNumberId: 'pnid-x' } };
      const res = mockRes();
      const next = jest.fn();

      await callbackEmbeddedSignup(req, res, next);

      expect(next).toHaveBeenCalledWith(errorDeMeta);

      const refrescada = await ChannelOnboardingSession.findById(session._id);
      expect(refrescada.status).toBe('failed');
      expect(refrescada.error.step).toBe('phone_resolution');
    });

    test('sessionId/wabaId/phoneNumberId faltantes: 400, no toca Mongo ni llama a Meta', async () => {
      const res = mockRes();
      const next = jest.fn();
      await callbackEmbeddedSignup({ businessId: business._id, body: { wabaId: 'w', phoneNumberId: 'p' } }, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(metaEmbeddedSignup.resolvePhoneNumber).not.toHaveBeenCalled();
    });
  });

  describe('flujo completo init → code → callback', () => {
    test('las 3 llamadas en secuencia dejan la sesión en gupshup_registering con todos los datos', async () => {
      metaEmbeddedSignup.exchangeCode.mockResolvedValue('token-del-flujo-completo');
      metaEmbeddedSignup.resolvePhoneNumber.mockResolvedValue({ phoneNumber: '+16315555556', verifiedName: 'CREA OS' });

      // 1. init
      const resInit = mockRes();
      await initEmbeddedSignup({ businessId: business._id, body: { displayName: 'Línea de ventas' } }, resInit, jest.fn());
      const sessionId = resInit.json.mock.calls[0][0].data.sessionId;

      // 2. code
      const resCode = mockRes();
      await codeEmbeddedSignup({ businessId: business._id, body: { sessionId: String(sessionId), code: 'code-real' } }, resCode, jest.fn());
      expect(resCode.status).toHaveBeenCalledWith(200);

      // 3. callback
      const resCallback = mockRes();
      await callbackEmbeddedSignup(
        { businessId: business._id, body: { sessionId: String(sessionId), wabaId: 'waba-real', phoneNumberId: 'pnid-real' } },
        resCallback,
        jest.fn()
      );
      expect(resCallback.status).toHaveBeenCalledWith(200);

      const final = await ChannelOnboardingSession.findById(sessionId);
      expect(final.status).toBe('gupshup_registering');
      expect(final.displayName).toBe('Línea de ventas');
      expect(final.meta.wabaId).toBe('waba-real');
      expect(final.meta.phoneNumberId).toBe('pnid-real');
      expect(final.meta.phoneNumber).toBe('+16315555556');
      expect(channelCrypto.decrypt(final.meta.accessTokenCipher, `onboarding:${final._id}`)).toBe('token-del-flujo-completo');
    });
  });
});

describe('channel.controller#completeGupshupEmbeddedSignup()', () => {
  let business;
  const requester = { email: 'ana@creaos.test', name: 'Ana Fundadora' };

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
    jest.clearAllMocks();
    // Default feliz para los 2 pasos nuevos de PR-06 — los tests que
    // necesitan otro comportamiento lo pisan explícito.
    partnerApps.getAppAccessToken.mockResolvedValue({ apikey: 'apikey-real-de-la-app' });
    partnerSubscriptions.subscribeToEvents.mockResolvedValue({ status: 'success' });
  });

  // Helper — sesión ya en 'gupshup_registering', con phoneNumber ya
  // resuelto (equivalente a lo que deja callbackEmbeddedSignup()).
  function crearSesionGupshupRegistering(overrides = {}) {
    return ChannelOnboardingSession.create({
      tenantId: business._id,
      status: 'gupshup_registering',
      meta: { wabaId: 'waba-real', phoneNumberId: 'pnid-real', phoneNumber: '+16315555556' },
      ...overrides,
    });
  }

  test('happy path (primera vez, sin appId todavía): crea la app, setea contacto, genera el link, sesión sigue en gupshup_registering', async () => {
    const session = await crearSesionGupshupRegistering();
    partnerAuth.getValidToken.mockResolvedValue('partner-token-real');
    partnerApps.createApp.mockResolvedValue({ appId: 'gs-app-real' });
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/xyz' });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(Object.keys(body.data).sort()).toEqual(['embedSignupUrl', 'expiresAt', 'sessionId', 'state']);
    expect(body.data.embedSignupUrl).toBe('https://embed.gupshup.io/xyz');

    expect(partnerApps.createApp).toHaveBeenCalledWith(
      { name: `creaos${business._id}` },
      'partner-token-real'
    );
    expect(partnerApps.getAppAccessToken).toHaveBeenCalledWith('gs-app-real', 'partner-token-real');
    expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledWith(
      'gs-app-real',
      'apikey-real-de-la-app',
      { url: 'https://backend.creaos.test/api/v1/webhooks/gupshup', tag: 'creaos-account-events', modes: ['ACCOUNT'] }
    );
    expect(partnerApps.setContactDetails).toHaveBeenCalledWith(
      'gs-app-real',
      { contactEmail: 'ana@creaos.test', contactName: 'Ana Fundadora', contactNumber: '+16315555556' },
      'partner-token-real'
    );
    expect(partnerApps.getEmbedSignupLink).toHaveBeenCalledWith(
      'gs-app-real',
      { user: 'ana@creaos.test', lang: 'es' },
      'partner-token-real'
    );

    const refrescada = await ChannelOnboardingSession.findById(session._id);
    expect(refrescada.status).toBe('gupshup_registering'); // sin transición nueva -- PR-06 la completa reactivamente al llegar el webhook
    expect(refrescada.gupshup.appId).toBe('gs-app-real');
    expect(refrescada.gupshup.webhookReference).toBe('gupshup:account-subscribed');
    expect(refrescada.gupshup.embedSignupUrl).toBe('https://embed.gupshup.io/xyz');
    expect(refrescada.gupshup.embedSignupUrlGeneratedAt).toBeInstanceOf(Date);
  });

  test('nombre de app determinístico: NO lleva guiones ni separadores (el tenantId ObjectId alcanza para unicidad)', async () => {
    const session = await crearSesionGupshupRegistering();
    partnerAuth.getValidToken.mockResolvedValue('token');
    partnerApps.createApp.mockResolvedValue({ appId: 'gs-app-real' });
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/xyz' });

    await completeGupshupEmbeddedSignup(
      { businessId: business._id, user: requester, body: { sessionId: String(session._id) } },
      mockRes(),
      jest.fn()
    );

    const [{ name }] = partnerApps.createApp.mock.calls[0];
    expect(name).not.toMatch(/-/);
    expect(name.startsWith('creaos')).toBe(true);
  });

  test('ya tiene appId de un intento previo (pero sin webhookReference todavía): NO vuelve a llamar createApp(), SÍ se suscribe a eventos ACCOUNT', async () => {
    const session = await crearSesionGupshupRegistering({ gupshup: { appId: 'gs-app-ya-creada' } });
    partnerAuth.getValidToken.mockResolvedValue('token');
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/xyz' });

    await completeGupshupEmbeddedSignup(
      { businessId: business._id, user: requester, body: { sessionId: String(session._id) } },
      mockRes(),
      jest.fn()
    );

    expect(partnerApps.createApp).not.toHaveBeenCalled();
    expect(partnerApps.getAppAccessToken).toHaveBeenCalledWith('gs-app-ya-creada', 'token');
    expect(partnerSubscriptions.subscribeToEvents).toHaveBeenCalledTimes(1);
    expect(partnerApps.setContactDetails).toHaveBeenCalledWith('gs-app-ya-creada', expect.any(Object), 'token');
  });

  test('ya tiene webhookReference de un intento previo: NO vuelve a llamar getAppAccessToken()/subscribeToEvents()', async () => {
    const session = await crearSesionGupshupRegistering({
      gupshup: { appId: 'gs-app-ya-creada', webhookReference: 'gupshup:account-subscribed' },
    });
    partnerAuth.getValidToken.mockResolvedValue('token');
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/xyz' });

    await completeGupshupEmbeddedSignup(
      { businessId: business._id, user: requester, body: { sessionId: String(session._id) } },
      mockRes(),
      jest.fn()
    );

    expect(partnerApps.createApp).not.toHaveBeenCalled();
    expect(partnerApps.getAppAccessToken).not.toHaveBeenCalled();
    expect(partnerSubscriptions.subscribeToEvents).not.toHaveBeenCalled();
    expect(partnerApps.setContactDetails).toHaveBeenCalledWith('gs-app-ya-creada', expect.any(Object), 'token');
  });

  // NOTA: el guard de "BACKEND_PUBLIC_URL no configurado" (channel.controller.js,
  // justo antes de armar la URL de suscripción) NO tiene un test dedicado acá
  // a propósito — a diferencia de GUPSHUP_PARTNER_EMAIL en partner.auth.test.js,
  // que se testea recargando el módulo con jest.isolateModules(), la cadena de
  // requires de channel.controller.js incluye modelos Mongoose (Channel
  // OnboardingSession.model.js) — recargarla en un registro aislado da una
  // instancia de mongoose desconectada, así que el guard quedaría probado
  // contra un doble falso silencioso (la sesión nunca se persistiría de
  // verdad). El guard sigue el mismo patrón exacto, ya testeado, de
  // GUPSHUP_PARTNER_EMAIL/SECRET en partner.auth.js#getValidToken().

  test('error de Gupshup al suscribirse a eventos ACCOUNT: se propaga, sesión queda failed con error.step:"gupshup_registration"', async () => {
    const session = await crearSesionGupshupRegistering({ gupshup: { appId: 'gs-app-ya-creada' } });
    partnerAuth.getValidToken.mockResolvedValue('token');
    const errorDeGupshup = Object.assign(new Error('Authentication Failed'), { statusCode: 401 });
    partnerSubscriptions.subscribeToEvents.mockRejectedValue(errorDeGupshup);

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(errorDeGupshup);
    expect(partnerApps.setContactDetails).not.toHaveBeenCalled();

    const refrescada = await ChannelOnboardingSession.findById(session._id);
    expect(refrescada.status).toBe('failed');
    expect(refrescada.error.step).toBe('gupshup_registration');
    expect(refrescada.gupshup.webhookReference).toBeNull();
  });

  test('sessionId inexistente: 404, no llama a Gupshup para nada', async () => {
    const req = { businessId: business._id, user: requester, body: { sessionId: new mongoose.Types.ObjectId().toString() } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
  });

  test('aislamiento: sesión de OTRO tenant devuelve 404', async () => {
    const otroNegocio = await Business.create({ name: 'Otro negocio' });
    const sesionAjena = await crearSesionGupshupRegistering({ tenantId: otroNegocio._id });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(sesionAjena._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  test('estado incorrecto (todavía en meta_authorized, falta /callback): 409 INVALID_SESSION_STATE', async () => {
    const session = await ChannelOnboardingSession.create({ tenantId: business._id, status: 'meta_authorized' });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.errors).toEqual({ code: 'INVALID_SESSION_STATE', currentState: 'meta_authorized' });
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
  });

  test('sesión expirada: 409 INVALID_SESSION_STATE currentState:"expired"', async () => {
    const session = await crearSesionGupshupRegistering();
    await ChannelOnboardingSession.updateOne({ _id: session._id }, { expiresAt: new Date(Date.now() - 1000) });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].errors).toEqual({ code: 'INVALID_SESSION_STATE', currentState: 'expired' });
  });

  test('error de Gupshup al crear la app: se propaga, sesión queda failed con error.step:"gupshup_registration"', async () => {
    const session = await crearSesionGupshupRegistering();
    partnerAuth.getValidToken.mockResolvedValue('token');
    const errorDeGupshup = Object.assign(new Error('Bot Already Exists'), { statusCode: 409 });
    partnerApps.createApp.mockRejectedValue(errorDeGupshup);

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(errorDeGupshup);

    const refrescada = await ChannelOnboardingSession.findById(session._id);
    expect(refrescada.status).toBe('failed');
    expect(refrescada.error.step).toBe('gupshup_registration');
    expect(refrescada.error.message).toBe('Bot Already Exists');
  });

  test('reintento tras un fallo DE ESTE MISMO paso: la sesión "failed" con error.step:"gupshup_registration" SÍ se puede reintentar, y no repite createApp() si el appId ya había quedado guardado', async () => {
    const session = await crearSesionGupshupRegistering({
      status: 'failed',
      error: { step: 'gupshup_registration', message: 'Internal Server Error' },
      gupshup: { appId: 'gs-app-de-intento-anterior' },
    });
    partnerAuth.getValidToken.mockResolvedValue('token');
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/reintento' });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(partnerApps.createApp).not.toHaveBeenCalled();

    const refrescada = await ChannelOnboardingSession.findById(session._id);
    expect(refrescada.status).toBe('gupshup_registering');
    expect(refrescada.gupshup.embedSignupUrl).toBe('https://embed.gupshup.io/reintento');
  });

  test('sesión "failed" de un paso ANTERIOR (Meta, no Gupshup): NO se puede reintentar acá, 409 INVALID_SESSION_STATE', async () => {
    const session = await crearSesionGupshupRegistering({
      status: 'failed',
      error: { step: 'phone_resolution', message: 'phoneNumberId no encontrado' },
    });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].errors).toEqual({ code: 'INVALID_SESSION_STATE', currentState: 'failed' });
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
  });

  test('sessionId faltante: 400, no toca Gupshup', async () => {
    const req = { businessId: business._id, user: requester, body: {} };
    const res = mockRes();
    const next = jest.fn();

    await completeGupshupEmbeddedSignup(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(partnerAuth.getValidToken).not.toHaveBeenCalled();
  });

  test('la respuesta NUNCA expone el token de partner ni datos de ChannelCredentials', async () => {
    const session = await crearSesionGupshupRegistering();
    partnerAuth.getValidToken.mockResolvedValue('partner-token-super-secreto');
    partnerApps.createApp.mockResolvedValue({ appId: 'gs-app-real' });
    partnerApps.setContactDetails.mockResolvedValue({ status: 'success' });
    partnerApps.getEmbedSignupLink.mockResolvedValue({ link: 'https://embed.gupshup.io/xyz' });

    const req = { businessId: business._id, user: requester, body: { sessionId: String(session._id) } };
    const res = mockRes();
    await completeGupshupEmbeddedSignup(req, res, jest.fn());

    const serializado = JSON.stringify(res.json.mock.calls[0][0]);
    expect(serializado).not.toMatch(/partner-token-super-secreto|accessTokenCipher|ciphertext/i);
  });
});
