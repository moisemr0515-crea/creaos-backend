// Test real (Jest, commiteado) de channel.repository.js#findByProviderAccountId()
// — la función que contiene la lógica de seguridad real del fix de
// resolución de canal en formato legacy de Gupshup (PR
// fix/gupshup-legacy-format-channel-resolution): 0 matches → null (sin
// cambio), 1 match → lo devuelve, 2+ matches → NUNCA elige uno al azar,
// loguea la ambigüedad y devuelve null. Esto último es lo que protege
// contra enrutar un mensaje de un tenant al CRM de otro (Principio 1 del
// Plan Maestro, aislamiento estructural).
//
// Contra Mongo real (mismo criterio que el resto del repo para lógica
// basada en Mongoose) en una base de datos propia de este archivo — así
// no colisiona con otros archivos de test que también usen Mongo, sin
// importar el orden/paralelismo con el que Jest los corra.
const mongoose = require('mongoose');
const WhatsAppChannel = require('./whatsappChannel.model');
const Business = require('../businesses/business.model');
const logger = require('../../utils/logger');
const channelRepository = require('./channel.repository');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_repository';

describe('channel.repository#findByProviderAccountId()', () => {
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

  test('sin providerAccountId (undefined), devuelve null sin consultar Mongo', async () => {
    const result = await channelRepository.findByProviderAccountId('gupshup', undefined);
    expect(result).toBeNull();
  });

  test('0 matches devuelve null (comportamiento sin cambio)', async () => {
    const result = await channelRepository.findByProviderAccountId('gupshup', 'AppQueNoExiste');
    expect(result).toBeNull();
  });

  test('1 match devuelve exactamente ese canal', async () => {
    const canal = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppUnica',
      phoneNumber: '+51900000001',
      phoneNumberId: 'pnid-repo-unica',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    const result = await channelRepository.findByProviderAccountId('gupshup', 'AppUnica');

    expect(result).not.toBeNull();
    expect(String(result._id)).toBe(String(canal._id));
  });

  test('2+ matches — el escenario crítico: NO elige ninguno al azar, devuelve null y loguea el error de ambigüedad', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppAmbigua',
      phoneNumber: '+51900000002',
      phoneNumberId: 'pnid-repo-ambigua-1',
      status: 'active',
      connectionType: 'DEDICATED',
    });
    await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAccountId: 'AppAmbigua',
      phoneNumber: '+51900000003',
      phoneNumberId: 'pnid-repo-ambigua-2',
      status: 'active',
      connectionType: 'DEDICATED',
    });

    const result = await channelRepository.findByProviderAccountId('gupshup', 'AppAmbigua');

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[channelRepository] providerAccountId ambiguo, no se pudo resolver el canal',
      expect.objectContaining({ provider: 'gupshup', providerAccountId: 'AppAmbigua', matches: 2 })
    );

    errorSpy.mockRestore();
  });
});
