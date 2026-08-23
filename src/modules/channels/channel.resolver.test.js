// Test real (Jest, commiteado) de channel.resolver.js#resolve() — cubre
// los 4 escenarios del fix de resolución de canal en formato legacy de
// Gupshup: regresión v3 (sin appName, se comporta exactamente igual que
// antes del fix), legacy con 1/0/2+ matches por appName.
//
// Contra Mongo real, en una base de datos propia de este archivo (no
// comparte datos con channel.repository.test.js ni con ningún otro test).
const mongoose = require('mongoose');
const WhatsAppChannel = require('./whatsappChannel.model');
const Business = require('../businesses/business.model');
const logger = require('../../utils/logger');
const channelRepository = require('./channel.repository');
const channelResolver = require('./channel.resolver');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_resolver';

describe('channel.resolver#resolve()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await WhatsAppChannel.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('REGRESIÓN v3: channelIdentifiers sin appName resuelve por phoneNumberId exactamente igual que antes del fix, y findByProviderAccountId() NUNCA se llama', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppV3',
      phoneNumber: '+51900000010',
      phoneNumberId: 'pnid-resolver-v3',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    const spy = jest.spyOn(channelRepository, 'findByProviderAccountId');

    // Mismo shape que manda inbound.gateway.js para un payload v3 real:
    // appName nunca viene en channelIdentifiers para ese formato.
    const result = await channelResolver.resolve({ provider: 'gupshup', phoneNumberId: 'pnid-resolver-v3' });

    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(canal._id));
    // El bloque nuevo `if (appName)` no debe ejecutarse en absoluto para v3.
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test('legacy con 1 canal matcheando: resuelve por appName', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppLegacyUnica',
      phoneNumber: '+51900000011',
      phoneNumberId: 'pnid-resolver-legacy-unica',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    // Mismo shape que manda inbound.gateway.js para un payload legacy real:
    // phoneNumberId/wabaId vienen undefined, solo appName.
    const result = await channelResolver.resolve({ provider: 'gupshup', appName: 'AppLegacyUnica' });

    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(canal._id));
  });

  test('legacy con 0 canales matcheando: devuelve null (mismo comportamiento que hoy para casos sin match)', async () => {
    const result = await channelResolver.resolve({ provider: 'gupshup', appName: 'AppLegacyQueNoExiste' });
    expect(result).toBeNull();
  });

  test('legacy con 2+ canales matcheando (ambiguo): NO devuelve ninguno al azar, devuelve null y loguea el error de ambigüedad', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppAmbiguaResolver',
      phoneNumber: '+51900000012',
      phoneNumberId: 'pnid-resolver-ambigua-1',
      status: 'active',
      connectionType: 'DEDICATED',
    });
    await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppAmbiguaResolver',
      phoneNumber: '+51900000013',
      phoneNumberId: 'pnid-resolver-ambigua-2',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    const result = await channelResolver.resolve({ provider: 'gupshup', appName: 'AppAmbiguaResolver' });

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[channelRepository] providerAccountId ambiguo, no se pudo resolver el canal',
      expect.objectContaining({ provider: 'gupshup', providerAccountId: 'AppAmbiguaResolver', matches: 2 })
    );

    errorSpy.mockRestore();
  });
});
