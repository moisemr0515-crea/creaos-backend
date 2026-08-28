// Test real (Jest, commiteado) de ChannelOnboardingSession — Fase 2.1 del
// blueprint Meta+Gupshup Embedded Signup (PR 1, solo el modelo).
//
// Contra Mongo real (mismo criterio que el resto del repo para lógica
// basada en Mongoose) en una base de datos propia de este archivo — así no
// colisiona con otros archivos de test que también usen Mongo, sin importar
// el orden/paralelismo con el que Jest los corra.
const mongoose = require('mongoose');
const ChannelOnboardingSession = require('./channelOnboardingSession.model');
const Business = require('../businesses/business.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_onboarding_session';

describe('ChannelOnboardingSession (modelo)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    // Espera a que los índices (unique de `state`, unique+sparse de
    // `channel`) terminen de construirse antes de correr nada — si no, la
    // primera vez que corre este archivo contra una colección nueva, las
    // pruebas de unicidad podrían correr contra índices todavía no listos.
    await ChannelOnboardingSession.init();
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

  test('status fuera del enum es rechazado por validación', async () => {
    await expect(
      ChannelOnboardingSession.create({ tenantId: business._id, status: 'no_es_un_status_valido' })
    ).rejects.toThrow(/no_es_un_status_valido/);
  });

  test('status default es "initiated" si no se especifica', async () => {
    const session = await ChannelOnboardingSession.create({ tenantId: business._id });
    expect(session.status).toBe('initiated');
  });

  test('acepta cada uno de los 6 valores documentados del enum', async () => {
    const STATUSES = ['initiated', 'meta_authorized', 'gupshup_registering', 'completed', 'failed', 'expired'];

    for (const status of STATUSES) {
      const session = await ChannelOnboardingSession.create({ tenantId: business._id, status });
      expect(session.status).toBe(status);
    }
  });

  test('state se autogenera único si no se especifica', async () => {
    const s1 = await ChannelOnboardingSession.create({ tenantId: business._id });
    const s2 = await ChannelOnboardingSession.create({ tenantId: business._id });

    expect(s1.state).toEqual(expect.any(String));
    expect(s1.state.length).toBeGreaterThan(0);
    expect(s1.state).not.toBe(s2.state);
  });

  test('unique constraint sobre state: 2 documentos con el mismo state explícito, el segundo falla', async () => {
    const stateCompartido = 'state-duplicado-a-proposito';

    await ChannelOnboardingSession.create({ tenantId: business._id, state: stateCompartido });

    await expect(
      ChannelOnboardingSession.create({ tenantId: business._id, state: stateCompartido })
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  test('unique + sparse sobre channel: varios documentos sin channel asignado conviven sin problema', async () => {
    const s1 = await ChannelOnboardingSession.create({ tenantId: business._id });
    const s2 = await ChannelOnboardingSession.create({ tenantId: business._id });
    const s3 = await ChannelOnboardingSession.create({ tenantId: business._id });

    // undefined, no null — a propósito (ver comentario del campo en el
    // modelo): así es como el índice sparse los excluye de la unicidad.
    expect(s1.channel).toBeUndefined();
    expect(s2.channel).toBeUndefined();
    expect(s3.channel).toBeUndefined();

    const count = await ChannelOnboardingSession.countDocuments({ channel: { $exists: false } });
    expect(count).toBe(3);
  });

  test('unique + sparse sobre channel: 2 documentos apuntando al mismo ObjectId real, el segundo falla', async () => {
    const channelId = new mongoose.Types.ObjectId();

    await ChannelOnboardingSession.create({ tenantId: business._id, status: 'completed', channel: channelId });

    await expect(
      ChannelOnboardingSession.create({ tenantId: business._id, status: 'completed', channel: channelId })
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  test('expiresAt se setea por default a ~30 minutos en el futuro al crear', async () => {
    const antes = Date.now();
    const session = await ChannelOnboardingSession.create({ tenantId: business._id });
    const despues = Date.now();

    const treintaMinutosMs = 30 * 60 * 1000;
    const margenMs = 5000; // tolerancia por el tiempo real que toma el create()

    expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(antes + treintaMinutosMs - margenMs);
    expect(session.expiresAt.getTime()).toBeLessThanOrEqual(despues + treintaMinutosMs + margenMs);
  });

  test('meta/gupshup/error quedan con sus defaults null cuando no se especifican', async () => {
    const session = await ChannelOnboardingSession.create({ tenantId: business._id });

    expect(session.displayName).toBeNull();

    expect(session.meta.wabaId).toBeNull();
    expect(session.meta.phoneNumberId).toBeNull();
    expect(session.meta.phoneNumber).toBeNull();
    expect(session.meta.metaBusinessId).toBeNull();
    expect(session.meta.accessTokenCipher).toBeNull();

    expect(session.gupshup.appId).toBeNull();
    expect(session.gupshup.webhookReference).toBeNull();
    expect(session.gupshup.embedSignupUrl).toBeNull();
    expect(session.gupshup.embedSignupUrlGeneratedAt).toBeNull();

    expect(session.error.step).toBeNull();
    expect(session.error.message).toBeNull();
  });

  test('tenantId es requerido', async () => {
    await expect(ChannelOnboardingSession.create({})).rejects.toThrow();
  });
});
