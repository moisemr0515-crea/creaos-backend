// Test real (Jest, commiteado) de channel.service.js#getChannelForConversation()
// — PR-10a (correctness de routing saliente, multi-canal por tenant). Este
// archivo no tenía ningún test hasta este PR.
//
// Contra Mongo real (WhatsAppChannel/Business/Lead/Conversation reales), en
// una base propia de este archivo. Nada de GupshupProvider/gupshup.client.js
// se toca — getChannelForConversation()/getChannelForTenant() solo resuelven
// QUÉ documento usar, nunca mandan nada.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const logger = require('../../utils/logger');
const channelService = require('./channel.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_channel_service';

describe('channelService#getChannelForConversation()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await WhatsAppChannel.deleteMany({});
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await WhatsAppChannel.deleteMany({});
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  function crearCanal(overrides = {}) {
    return WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      connectionType: 'DEDICATED',
      status: 'active',
      ...overrides,
    });
  }

  async function crearConversacion(overrides = {}) {
    const lead = await Lead.create({ business: business._id, name: 'Lead de prueba' });
    return Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      status: 'active',
      ...overrides,
    });
  }

  test('(a) tenant con 2 canales activos: conversation.whatsappChannel = A -> resuelve A, nunca B', async () => {
    const canalVentas = await crearCanal({ phoneNumberId: 'pnid-ventas', phoneNumber: '+51900000001', displayName: 'Ventas' });
    const canalSoporte = await crearCanal({ phoneNumberId: 'pnid-soporte', phoneNumber: '+51900000002', displayName: 'Soporte' });
    const conversacion = await crearConversacion({ whatsappChannel: canalVentas._id });

    const resuelto = await channelService.getChannelForConversation(conversacion, business._id);

    expect(String(resuelto._id)).toBe(String(canalVentas._id));
    expect(String(resuelto._id)).not.toBe(String(canalSoporte._id));
  });

  test('(a bis) mismo escenario, pero la conversation apunta al OTRO canal (B) -> resuelve B, no A — confirma que no hay ningún sesgo hacia "el primero creado"', async () => {
    const canalVentas = await crearCanal({ phoneNumberId: 'pnid-ventas-2', phoneNumber: '+51900000003' });
    const canalSoporte = await crearCanal({ phoneNumberId: 'pnid-soporte-2', phoneNumber: '+51900000004' });
    const conversacion = await crearConversacion({ whatsappChannel: canalSoporte._id });

    const resuelto = await channelService.getChannelForConversation(conversacion, business._id);

    expect(String(resuelto._id)).toBe(String(canalSoporte._id));
    expect(String(resuelto._id)).not.toBe(String(canalVentas._id));
  });

  test('(b) conversación vieja SIN whatsappChannel poblado: cae al fallback ("primer canal activo del tenant"), no rompe', async () => {
    await crearCanal({ phoneNumberId: 'pnid-unico', phoneNumber: '+51900000005' });
    const conversacion = await crearConversacion(); // whatsappChannel queda default:null

    const resuelto = await channelService.getChannelForConversation(conversacion, business._id);

    expect(resuelto).not.toBeNull();
    expect(resuelto.phoneNumberId).toBe('pnid-unico');
  });

  test('(b bis) conversation es null/undefined (caller sin conversación real disponible): cae al fallback igual, nunca explota', async () => {
    await crearCanal({ phoneNumberId: 'pnid-sin-conv', phoneNumber: '+51900000006' });

    const resueltoNull = await channelService.getChannelForConversation(null, business._id);
    const resueltoUndefined = await channelService.getChannelForConversation(undefined, business._id);

    expect(resueltoNull.phoneNumberId).toBe('pnid-sin-conv');
    expect(resueltoUndefined.phoneNumberId).toBe('pnid-sin-conv');
  });

  test('(c) tenant con 1 solo canal activo (el caso de hoy, 100% de la base): mismo resultado con o sin whatsappChannel poblado — CERO cambio de comportamiento', async () => {
    const unicoCanal = await crearCanal({ phoneNumberId: 'pnid-solo-uno', phoneNumber: '+51900000007' });

    const conversacionSinPoblar = await crearConversacion();
    const conversacionPoblada = await crearConversacion({ whatsappChannel: unicoCanal._id });

    const resuelto1 = await channelService.getChannelForConversation(conversacionSinPoblar, business._id);
    const resuelto2 = await channelService.getChannelForConversation(conversacionPoblada, business._id);
    const resuelto3 = await channelService.getChannelForTenant(business._id); // comportamiento de siempre, función sin tocar

    expect(String(resuelto1._id)).toBe(String(unicoCanal._id));
    expect(String(resuelto2._id)).toBe(String(unicoCanal._id));
    expect(String(resuelto3._id)).toBe(String(unicoCanal._id));
  });

  test('whatsappChannel apunta a un id que no existe (referencia rota, caso hoy imposible): cae al fallback y loguea warning', async () => {
    const canalReal = await crearCanal({ phoneNumberId: 'pnid-fallback-roto', phoneNumber: '+51900000008' });
    const idInexistente = new mongoose.Types.ObjectId();
    const conversacion = await crearConversacion({ whatsappChannel: idInexistente });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const resuelto = await channelService.getChannelForConversation(conversacion, business._id);

    expect(String(resuelto._id)).toBe(String(canalReal._id));
    expect(warnSpy).toHaveBeenCalledWith(
      '[channelService] conversation.whatsappChannel no resolvió a un WhatsAppChannel activo, cae al fallback de "primer canal activo del tenant"',
      expect.objectContaining({ whatsappChannel: String(idInexistente), encontrado: false, statusEncontrado: null })
    );

    warnSpy.mockRestore();
  });

  test('whatsappChannel apunta a un canal real pero YA NO activo (suspendido/desconectado): cae al fallback, no intenta mandar por un canal muerto', async () => {
    const canalSuspendido = await crearCanal({ phoneNumberId: 'pnid-suspendido', phoneNumber: '+51900000009', status: 'suspended' });
    const canalSanoDeOtroTenant = await crearCanal({ phoneNumberId: 'pnid-sano', phoneNumber: '+51900000010' });
    const conversacion = await crearConversacion({ whatsappChannel: canalSuspendido._id });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const resuelto = await channelService.getChannelForConversation(conversacion, business._id);

    expect(String(resuelto._id)).toBe(String(canalSanoDeOtroTenant._id));
    expect(String(resuelto._id)).not.toBe(String(canalSuspendido._id));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ encontrado: true, statusEncontrado: 'suspended' })
    );

    warnSpy.mockRestore();
  });

  test('sin ningún canal activo (ni por whatsappChannel ni por fallback): devuelve null, no explota', async () => {
    const conversacion = await crearConversacion();
    const resuelto = await channelService.getChannelForConversation(conversacion, business._id);
    expect(resuelto).toBeNull();
  });
});
