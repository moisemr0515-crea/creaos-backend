// Test real (Jest, Mongo real en base propia) de channelOnboardingStatus.service.js:
// traduce la ChannelOnboardingSession (+ calendario del barrido) a una fase y una acción
// siguiente para el frontend de autoservicio. Sin llamadas externas: es solo lectura.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const { getCurrentOnboarding, FASES, ACCIONES } = require('./channelOnboardingStatus.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_status';
const DIA = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const hace = (ms) => new Date(Date.now() - ms);
const TEL = '+51900000101';

describe('channelOnboardingStatus — fase y acción siguiente de la conexión en curso', () => {
  let tenantA;
  let tenantB;

  beforeAll(async () => { await mongoose.connect(MONGO_URI); });
  afterAll(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await ChannelOnboardingSession.deleteMany({});
    await Business.deleteMany({});
    tenantA = await Business.create({ name: 'Tenant A' });
    tenantB = await Business.create({ name: 'Tenant B' });
  });

  const sesion = async (tenant, { status = 'gupshup_registering', gupshup = {}, meta = {}, createdAt, ...resto } = {}) => {
    const doc = await ChannelOnboardingSession.create({
      tenantId: tenant._id,
      status,
      meta: {
        wabaId: '1000000000000101', phoneNumberId: '1000000000000501', phoneNumber: TEL,
        accessTokenCipher: { ciphertext: 'c', iv: 'i', authTag: 't', keyVersion: 1 },
        ...meta,
      },
      gupshup: {
        appId: 'app-propia', appName: 'creaosnueva', webhookReference: 'gupshup:account-subscribed',
        messagesWebhookReference: 'gupshup:messages-subscribed', embedSignupUrl: 'https://gs.tc.im/abc',
        embedSignupUrlGeneratedAt: hace(10 * MIN), ...gupshup,
      },
      expiresAt: new Date(Date.now() + 4 * DIA),
      ...resto,
    });
    // createdAt es inmutable en el schema: se fija con el driver nativo.
    if (createdAt) await ChannelOnboardingSession.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
    return doc;
  };

  const actual = (tenant = tenantA) => getCurrentOnboarding({ tenantId: tenant._id });

  describe('fases de una sesión en gupshup_registering', () => {
    test('con app y enlace vigentes: awaiting_gupshup, acción open_link, y trae el enlace y su vencimiento', async () => {
      const generado = hace(10 * MIN);
      const s = await sesion(tenantA, { gupshup: { embedSignupUrlGeneratedAt: generado } });

      const r = await actual();

      expect(r).toMatchObject({ sessionId: String(s._id), phase: FASES.AWAITING_GUPSHUP, nextAction: ACCIONES.OPEN_LINK, phoneNumber: TEL, embedSignupUrl: 'https://gs.tc.im/abc' });
      expect(new Date(r.linkExpiresAt).getTime()).toBe(generado.getTime() + 5 * DIA);
    });

    test('un error transitorio del último chequeo no cambia la fase: sigue awaiting_gupshup con motivo temporary_error', async () => {
      await sesion(tenantA, { reconcile: { attempts: 3, lastOutcome: 'error', lastAttemptAt: hace(MIN) } });
      const r = await actual();
      expect(r).toMatchObject({ phase: FASES.AWAITING_GUPSHUP, reason: 'temporary_error' });
      expect(new Date(r.lastCheckAt).getTime()).toBeGreaterThan(Date.now() - 2 * MIN);
    });

    test('sin app o sin enlace: needs_registration, acción register, sin enlace', async () => {
      await sesion(tenantA, { gupshup: { appId: null, embedSignupUrl: null, embedSignupUrlGeneratedAt: null } });
      const r = await actual();
      expect(r).toMatchObject({ phase: FASES.NEEDS_REGISTRATION, nextAction: ACCIONES.REGISTER });
      expect(r.embedSignupUrl).toBeUndefined();
    });

    test('ventana vencida o enlace de más de 5 días: link_expired, acción recover (sin repetir Meta)', async () => {
      await sesion(tenantA, { expiresAt: hace(MIN) });
      expect(await actual()).toMatchObject({ phase: FASES.LINK_EXPIRED, nextAction: ACCIONES.RECOVER });

      await ChannelOnboardingSession.deleteMany({});
      await sesion(tenantA, { gupshup: { embedSignupUrlGeneratedAt: hace(6 * DIA) }, expiresAt: new Date(Date.now() + DIA) });
      const r = await actual();
      expect(r).toMatchObject({ phase: FASES.LINK_EXPIRED, nextAction: ACCIONES.RECOVER });
      expect(r.embedSignupUrl).toBeUndefined(); // nunca se ofrece un enlace vencido
    });

    test.each([
      ['mismatch', ACCIONES.RESTART, 'number_mismatch'],
      ['identity_conflict', ACCIONES.CONTACT_SUPPORT, 'identity_conflict'],
      ['app_unsafe', ACCIONES.RECOVER, 'app_not_safe'],
      ['stale', ACCIONES.RECOVER, 'link_expired'],
      ['excepcion_al_activar', ACCIONES.VERIFY, 'activation_failed'],
    ])('el barrido se detuvo por "%s": needs_attention con la acción %s y motivo %s (no se ofrece el enlace)', async (stoppedReason, nextAction, reason) => {
      await sesion(tenantA, { reconcile: { stoppedAt: new Date(), stoppedReason } });
      const r = await actual();
      expect(r).toMatchObject({ phase: FASES.NEEDS_ATTENTION, nextAction, reason });
      expect(r.embedSignupUrl).toBeUndefined();
    });

    test('gupshup_link detenido por mismatch ofrece verificar el número existente, no reiniciar el onboarding', async () => {
      await sesion(tenantA, {
        mode: 'gupshup_link',
        declaredPhone: TEL,
        meta: { wabaId: null, phoneNumberId: null, phoneNumber: null, accessTokenCipher: null },
        reconcile: { stoppedAt: new Date(), stoppedReason: 'mismatch' },
      });

      expect(await actual()).toMatchObject({
        mode: 'gupshup_link',
        phase: FASES.NEEDS_ATTENTION,
        nextAction: ACCIONES.VERIFY,
        reason: 'number_mismatch',
        phoneNumber: TEL,
      });
    });
  });

  describe('otros estados', () => {
    test('completing: activating / wait', async () => {
      await sesion(tenantA, { status: 'completing' });
      expect(await actual()).toMatchObject({ phase: FASES.ACTIVATING, nextAction: ACCIONES.WAIT });
    });

    test('failed en gupshup_registration: registration_failed / register, con el mensaje del error', async () => {
      await sesion(tenantA, { status: 'failed', error: { step: 'gupshup_registration', message: 'Gupshup no respondió' } });
      expect(await actual()).toMatchObject({ phase: FASES.REGISTRATION_FAILED, nextAction: ACCIONES.REGISTER, errorMessage: 'Gupshup no respondió' });
    });

    test('failed en channel_creation: activating mientras el barrido reintenta; needs_attention/verify si ya se detuvo', async () => {
      const s = await sesion(tenantA, { status: 'failed', error: { step: 'channel_creation', message: 'x' } });
      expect(await actual()).toMatchObject({ phase: FASES.ACTIVATING, nextAction: ACCIONES.WAIT, reason: 'retrying_activation' });

      await ChannelOnboardingSession.updateOne({ _id: s._id }, { $set: { 'reconcile.stoppedAt': new Date(), 'reconcile.stoppedReason': 'excepcion_al_activar' } });
      expect(await actual()).toMatchObject({ phase: FASES.NEEDS_ATTENTION, nextAction: ACCIONES.VERIFY });
    });

    test('expired con la autorización de Meta completa: link_expired / recover; sin ella no es accionable (null)', async () => {
      await sesion(tenantA, { status: 'expired' });
      expect(await actual()).toMatchObject({ phase: FASES.LINK_EXPIRED, nextAction: ACCIONES.RECOVER });

      await ChannelOnboardingSession.deleteMany({});
      await sesion(tenantA, { status: 'expired', meta: { wabaId: null, phoneNumberId: null, phoneNumber: null, accessTokenCipher: null } });
      expect(await actual()).toBeNull();
    });

    test.each(['initiated', 'exchanging_code', 'meta_authorized', 'resolving_number'])('%s (popup de Meta abandonado): no es una conexión en curso accionable -> null', async (status) => {
      await sesion(tenantA, { status });
      expect(await actual()).toBeNull();
    });

    test('completed: nada en curso (null); lo informa /whatsapp/status', async () => {
      await sesion(tenantA, { status: 'completed' });
      expect(await actual()).toBeNull();
    });
  });

  describe('qué sesión se elige', () => {
    test('un intento abandonado en Meta (más nuevo) no esconde una conexión que sí espera a Gupshup', async () => {
      const esperando = await sesion(tenantA, { createdAt: hace(2 * 60 * MIN) });
      await sesion(tenantA, { status: 'initiated', meta: { wabaId: null, phoneNumberId: null, phoneNumber: null, accessTokenCipher: null } });
      expect((await actual()).sessionId).toBe(String(esperando._id));
    });

    test('si la sesión más reciente ya se completó, no se resucita una pendiente anterior', async () => {
      await sesion(tenantA, { createdAt: hace(3 * DIA) });
      await sesion(tenantA, { status: 'completed', createdAt: hace(DIA) });
      expect(await actual()).toBeNull();
    });

    test('sesiones de más de 7 días se ignoran', async () => {
      await sesion(tenantA, { createdAt: hace(8 * DIA) });
      expect(await actual()).toBeNull();
    });

    test('entre varias accionables gana la más reciente', async () => {
      await sesion(tenantA, { createdAt: hace(2 * DIA), gupshup: { appId: 'app-vieja' } });
      const nueva = await sesion(tenantA, { createdAt: hace(DIA), gupshup: { appId: 'app-nueva' } });
      expect((await actual()).sessionId).toBe(String(nueva._id));
    });
  });

  describe('aislamiento y datos expuestos', () => {
    test('nunca devuelve la sesión de otro tenant', async () => {
      await sesion(tenantB);
      expect(await actual(tenantA)).toBeNull();
      expect((await actual(tenantB)).phase).toBe(FASES.AWAITING_GUPSHUP);
    });

    test('solo expone campos de presentación: sin token de Meta, appId, apikeys, IDs de WABA ni referencias internas', async () => {
      await sesion(tenantA);
      const r = await actual();
      expect(Object.keys(r).sort()).toEqual(
        ['embedSignupUrl', 'expiresAt', 'lastCheckAt', 'linkExpiresAt', 'mode', 'nextAction', 'phase', 'phoneNumber', 'reason', 'sessionId', 'status'].sort()
      );
      expect(JSON.stringify(r)).not.toMatch(/accessTokenCipher|app-propia|wabaId|phoneNumberId|apikey|webhookReference/i);
    });
  });
});
