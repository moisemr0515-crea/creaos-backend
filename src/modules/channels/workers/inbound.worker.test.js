// Test real (Jest, commiteado) del port de paridad Track 1 #5 (auditoría de
// pricing del 24/ago/2026): inbound.worker.js#processInboundJob() ahora usa
// leadService.resolveNotificationRecipients() (fallback owner/admin, no solo
// lead.assignedTo) y dispara aiService.qualifyLead() después de encolar la
// respuesta — mismos 2 gaps de paridad que webhook.service.js#
// processGupshupMessage() ya tenía resueltos y validados en producción.
//
// enqueueOutbound() se mockea con jest.mock() (no jest.spyOn) porque
// inbound.worker.js lo importa DESTRUCTURADO (`const { enqueueOutbound } =
// require(...)`) — una mutación posterior del módulo real no alcanzaría esa
// referencia ya capturada. aiService/pushService SÍ se pueden interceptar
// con jest.spyOn porque inbound.worker.js los importa como objeto completo
// (`const aiService = require(...)`), así que ambos apuntan al mismo objeto
// compartido por Node — mismo criterio de "referencia viva" usado en el
// resto de tests de este repo.
//
// Los tests de la rama aiEnabled:false pre-crean Lead+Conversation con
// aiEnabled:false directo en Mongo (en vez de dejar que
// ensureLeadAndConversation() los cree con el default true) — así el job
// nunca llega a agentRuntime.process()/aiService.generateReply() en esos
// casos, sin necesidad de mockear nada de la IA para probar la rama de
// notificación.
jest.mock('../queues/outbound.queue', () => ({
  enqueueOutbound: jest.fn().mockResolvedValue(undefined),
  getOutboundQueue: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Conversation = require('../../ai/conversation.model');
const InboundEvent = require('../inboundEvent.model');
const OutboundEvent = require('../outboundEvent.model');
const Notification = require('../../admin/notification.model');
const User = require('../../users/user.model');
const Role = require('../../roles/role.model');
const aiService = require('../../ai/ai.service');
const pushService = require('../../push/push.service');
const { enqueueOutbound } = require('../queues/outbound.queue');
const { processInboundJob } = require('./inbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_inbound_worker_parity';
const PHONE = '+51900000001';

describe('inbound.worker#processInboundJob() — paridad con processGupshupMessage()', () => {
  let business;
  let roleOwner;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    roleOwner = await Role.findOneAndUpdate(
      { slug: 'owner', business: null },
      { name: 'Owner', slug: 'owner', business: null, isSystem: true, permissions: [] },
      { upsert: true, new: true }
    );
  });

  afterAll(async () => {
    await Notification.deleteMany({});
    await OutboundEvent.deleteMany({});
    await InboundEvent.deleteMany({});
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await User.deleteMany({});
    await Business.deleteMany({});
    await Role.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    await Notification.deleteMany({});
    await OutboundEvent.deleteMany({});
    await InboundEvent.deleteMany({});
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await User.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearInboundEvent = (overrides = {}) =>
    InboundEvent.create({
      providerMessageId: `msg-${new mongoose.Types.ObjectId()}`,
      provider: 'gupshup',
      channel: new mongoose.Types.ObjectId(),
      tenantId: business._id,
      from: PHONE,
      text: 'Sigo esperando respuesta',
      status: 'received',
      ...overrides,
    });

  /** Pre-crea Lead+Conversation con aiEnabled:false, sin assignedTo — el estado real que deja un agente humano tomando control (sendAgentMessage()). */
  const crearLeadYConversacionSinIA = async () => {
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead existente',
      phone: PHONE,
      source: 'whatsapp',
      activity: [],
    });
    const conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      status: 'active',
      aiEnabled: false,
    });
    return { lead, conversation };
  };

  test('fallback owner/admin: sin lead.assignedTo, notifica al owner del negocio (antes no notificaba a nadie)', async () => {
    const owner = await User.create({
      business: business._id,
      name: 'Dueño',
      email: `owner-${new mongoose.Types.ObjectId()}@test.com`,
      password: 'hash-de-prueba',
      role: roleOwner._id,
      isActive: true,
    });
    await crearLeadYConversacionSinIA();

    const event = await crearInboundEvent();
    await processInboundJob({ data: { inboundEventId: event._id } });

    const notifs = await Notification.find({ business: business._id, category: 'lead' });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].user.toString()).toBe(owner._id.toString());
    expect(pushService.sendToUser).not.toBeUndefined(); // sanity: el módulo real sigue existiendo

    const updatedEvent = await InboundEvent.findById(event._id);
    expect(updatedEvent.status).toBe('processed');
  });

  test('sin ningún owner/admin activo: no revienta, no notifica (mismo fail-soft que el legacy)', async () => {
    await crearLeadYConversacionSinIA();
    jest.spyOn(pushService, 'sendToUser').mockResolvedValue();

    const event = await crearInboundEvent();
    await expect(processInboundJob({ data: { inboundEventId: event._id } })).resolves.toBeUndefined();

    expect(await Notification.countDocuments({ business: business._id })).toBe(0);
    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });

  test('qualifyLead() se dispara después de encolar una respuesta de la IA', async () => {
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: 'Hola, claro, contame más', tokensUsed: 42 });
    const qualifySpy = jest.spyOn(aiService, 'qualifyLead').mockResolvedValue({ score: 70, temperature: 'warm' });

    const event = await crearInboundEvent();
    await processInboundJob({ data: { inboundEventId: event._id } });

    expect(enqueueOutbound).toHaveBeenCalledTimes(1);
    // Fire-and-forget — esperamos un tick para que la promesa no-awaited corra.
    await new Promise((resolve) => setImmediate(resolve));
    expect(qualifySpy).toHaveBeenCalledTimes(1);

    const conversation = await Conversation.findOne({ business: business._id });
    expect(qualifySpy).toHaveBeenCalledWith(conversation._id, expect.objectContaining({ _id: conversation.lead }));
  });

  test('qualifyLead() NO se dispara si la IA decide no responder (reply:null)', async () => {
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: null, tokensUsed: 5 });
    const qualifySpy = jest.spyOn(aiService, 'qualifyLead').mockResolvedValue({});

    const event = await crearInboundEvent();
    await processInboundJob({ data: { inboundEventId: event._id } });

    expect(enqueueOutbound).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(qualifySpy).not.toHaveBeenCalled();
  });

  test('un fallo de qualifyLead() no revienta el job (fail-soft, mismo criterio que el legacy)', async () => {
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: 'Respuesta normal', tokensUsed: 10 });
    jest.spyOn(aiService, 'qualifyLead').mockRejectedValue(new Error('OpenAI caído'));

    const event = await crearInboundEvent();
    await expect(processInboundJob({ data: { inboundEventId: event._id } })).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    const updatedEvent = await InboundEvent.findById(event._id);
    expect(updatedEvent.status).toBe('processed');
  });
});
