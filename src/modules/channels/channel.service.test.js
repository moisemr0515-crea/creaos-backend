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

  test('(b) conversación vieja SIN whatsappChannel: falla explícitamente y exige reasignación', async () => {
    await crearCanal({ phoneNumberId: 'pnid-unico', phoneNumber: '+51900000005' });
    const conversacion = await crearConversacion(); // whatsappChannel queda default:null

    await expect(channelService.getChannelForConversation(conversacion, business._id)).rejects.toMatchObject({ statusCode: 409 });
    const refreshed = await Conversation.findById(conversacion._id);
    expect(refreshed.whatsappChannelStatus).toBe('reassignment_required');
  });

  test('(b bis) conversation null/undefined: falla cerrado, nunca selecciona el primer canal', async () => {
    await crearCanal({ phoneNumberId: 'pnid-sin-conv', phoneNumber: '+51900000006' });

    await expect(channelService.getChannelForConversation(null, business._id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(channelService.getChannelForConversation(undefined, business._id)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('(c) aun con un solo canal activo, solo una referencia explícita permite resolverlo', async () => {
    const unicoCanal = await crearCanal({ phoneNumberId: 'pnid-solo-uno', phoneNumber: '+51900000007' });

    const conversacionSinPoblar = await crearConversacion();
    const conversacionPoblada = await crearConversacion({ whatsappChannel: unicoCanal._id });

    await expect(channelService.getChannelForConversation(conversacionSinPoblar, business._id)).rejects.toMatchObject({ statusCode: 409 });
    const resuelto2 = await channelService.getChannelForConversation(conversacionPoblada, business._id);
    const resuelto3 = await channelService.getChannelForTenant(business._id); // comportamiento de siempre, función sin tocar

    expect(String(resuelto2._id)).toBe(String(unicoCanal._id));
    expect(String(resuelto3._id)).toBe(String(unicoCanal._id));
  });

  test('whatsappChannel apunta a un id inexistente: falla cerrado, aunque haya otro canal activo', async () => {
    const canalReal = await crearCanal({ phoneNumberId: 'pnid-fallback-roto', phoneNumber: '+51900000008' });
    const idInexistente = new mongoose.Types.ObjectId();
    const conversacion = await crearConversacion({ whatsappChannel: idInexistente });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(channelService.getChannelForConversation(conversacion, business._id)).rejects.toMatchObject({ statusCode: 409 });
    expect(warnSpy).toHaveBeenCalledWith(
      '[channelService] canal original no operativo; envío bloqueado hasta reasignación',
      expect.objectContaining({ channelId: String(idInexistente) })
    );

    warnSpy.mockRestore();
  });

  test('whatsappChannel inactivo: no usa el otro número activo del tenant', async () => {
    const canalSuspendido = await crearCanal({ phoneNumberId: 'pnid-suspendido', phoneNumber: '+51900000009', status: 'suspended' });
    const canalSanoDeOtroTenant = await crearCanal({ phoneNumberId: 'pnid-sano', phoneNumber: '+51900000010' });
    const conversacion = await crearConversacion({ whatsappChannel: canalSuspendido._id });
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(channelService.getChannelForConversation(conversacion, business._id)).rejects.toMatchObject({ statusCode: 409 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ channelId: String(canalSuspendido._id) })
    );

    warnSpy.mockRestore();
  });

  test('sin ningún canal asignado: falla explícitamente', async () => {
    const conversacion = await crearConversacion();
    await expect(channelService.getChannelForConversation(conversacion, business._id)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('reasignación explícita a canal activo del mismo tenant conserva auditoría', async () => {
    const original = await crearCanal({ phoneNumberId: 'pnid-original', phoneNumber: '+51900000011', status: 'disconnected' });
    const target = await crearCanal({ phoneNumberId: 'pnid-target', phoneNumber: '+51900000012' });
    const conversation = await crearConversacion({ whatsappChannel: original._id });
    const actorId = new mongoose.Types.ObjectId();
    const updated = await channelService.reassignConversationChannel({ conversationId: conversation._id, channelId: target._id, tenantId: business._id, actorId });
    expect(String(updated.whatsappChannel)).toBe(String(target._id));
    expect(updated.whatsappChannelHistory).toHaveLength(1);
    expect(String(updated.whatsappChannelHistory[0].from)).toBe(String(original._id));
  });

  test('reasignación a canal de otro tenant es rechazada', async () => {
    const other = await Business.create({ name: 'Otro negocio' });
    const foreign = await WhatsAppChannel.create({ tenantId: other._id, businessId: other._id, provider: 'gupshup', connectionType: 'DEDICATED', status: 'active', phoneNumberId: 'pnid-foreign', phoneNumber: '+51900000013' });
    const conversation = await crearConversacion();
    await expect(channelService.reassignConversationChannel({ conversationId: conversation._id, channelId: foreign._id, tenantId: business._id, actorId: new mongoose.Types.ObjectId() })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('canal desconectado bloquea nuevos envíos antes de invocar al provider', async () => {
    const channel = await crearCanal({ phoneNumberId: 'pnid-disconnected-send', phoneNumber: '+51900000014', status: 'disconnected' });
    await expect(channelService.sendMessage(channel._id, '+51911111111', 'hola', business._id)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('channelId de otro tenant no puede operarse aunque el id sea conocido', async () => {
    const other = await Business.create({ name: 'Tenant externo' });
    const foreign = await WhatsAppChannel.create({ tenantId: other._id, businessId: other._id, provider: 'gupshup', connectionType: 'DEDICATED', status: 'active', phoneNumberId: 'pnid-known-foreign', phoneNumber: '+51900000015' });
    await expect(channelService.sendMessage(foreign._id, '+51911111111', 'hola', business._id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
