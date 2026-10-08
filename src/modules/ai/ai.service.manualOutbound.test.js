jest.mock('../channels/queues/outbound.queue', () => ({
  enqueueOutbound: jest.fn().mockResolvedValue(undefined),
}));

const mongoose = require('mongoose');
const aiService = require('./ai.service');
const Conversation = require('./conversation.model');
const Lead = require('../leads/lead.model');
const Business = require('../businesses/business.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const OutboundEvent = require('../channels/outboundEvent.model');
const channelService = require('../channels/channel.service');
const subscriptionService = require('../subscriptions/subscription.service');
const { enqueueOutbound } = require('../channels/queues/outbound.queue');
const { processOutboundJob } = require('../channels/workers/outbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_manual_outbound_p1';

describe('mensajería manual durable por WhatsApp', () => {
  let tenantId;
  let actor;
  let lead;
  let channel;
  let conversation;

  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    enqueueOutbound.mockReset().mockResolvedValue(undefined);
    await mongoose.connection.dropDatabase();

    const business = await Business.create({ name: 'CREA OS', agentName: 'Asesora CREA' });
    tenantId = business._id;
    actor = { _id: new mongoose.Types.ObjectId(), name: 'Agente', business: tenantId };
    lead = await Lead.create({ business: tenantId, name: 'Lead', phone: '+51900000000' });
    channel = await WhatsAppChannel.create({
      tenantId,
      businessId: tenantId,
      provider: 'gupshup',
      phoneNumber: '+51911111111',
      phoneNumberId: `phone-${new mongoose.Types.ObjectId()}`,
      status: 'active',
      connectionType: 'PLATFORM',
    });
    conversation = await Conversation.create({
      business: tenantId,
      tenantId,
      lead: lead._id,
      channel: 'whatsapp',
      whatsappChannel: channel._id,
      lastInboundMessageAt: new Date(),
      aiEnabled: true,
    });
  });

  const options = (key) => ({ tenantId, idempotencyKey: key });

  test('texto manual persiste mensaje y OutboundEvent, encola y no llama al proveedor desde el request', async () => {
    const directSend = jest.spyOn(channelService, 'sendMessage');

    const message = await aiService.sendAgentMessage(conversation._id, 'Hola', actor, options('text-1'));

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event).toMatchObject({ origin: 'manual', messageType: 'text', status: 'pending', text: 'Hola' });
    expect(event.payload).toEqual({ text: 'Hola' });
    expect(message.whatsappStatus).toBe('queued');
    expect(String(message.outboundEventId)).toBe(String(event._id));
    expect(enqueueOutbound).toHaveBeenCalledWith(event._id);
    expect(directSend).not.toHaveBeenCalled();
  });

  test('template manual usa el mismo OutboundEvent durable', async () => {
    const directSend = jest.spyOn(channelService, 'sendTemplate');
    jest.spyOn(channelService, 'getApprovedTemplate').mockResolvedValue({
      providerTemplateId: 'bienvenida', name: 'bienvenida', variablesRequired: 1,
    });
    await aiService.sendTemplateMessage(
      conversation._id,
      { id: 'bienvenida', params: ['Ana'] },
      actor,
      options('template-1')
    );

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event.messageType).toBe('template');
    expect(event.payload.template).toEqual({ id: 'bienvenida', params: ['Ana'] });
    expect(enqueueOutbound).toHaveBeenCalledWith(event._id);
    expect(directSend).not.toHaveBeenCalled();
  });


  test('primer contacto sin inbound bloquea texto libre antes de crear OutboundEvent', async () => {
    conversation.lastInboundMessageAt = null;
    await conversation.save();

    await expect(aiService.sendAgentMessage(conversation._id, 'No enviar', actor, options('first-contact-text')))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await OutboundEvent.countDocuments({ conversation: conversation._id })).toBe(0);
  });

  test('seguimiento_comercial ignora valores automáticos del cliente y usa Lead/Business reales', async () => {
    jest.spyOn(channelService, 'getApprovedTemplate').mockResolvedValue({
      providerTemplateId: 'tpl-seguimiento', name: 'seguimiento_comercial', variablesRequired: 3,
    });

    await aiService.sendTemplateMessage(
      conversation._id,
      { id: 'tpl-seguimiento', params: ['Incorrecto', 'Incorrecto', 'Incorrecto'] },
      actor,
      options('template-auto-values')
    );

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event.payload.template.params).toEqual(['Lead', 'Asesora CREA', 'CREA OS']);
  });

  test('recordatorio_cita sin fecha/hora no crea mensaje ni OutboundEvent', async () => {
    jest.spyOn(channelService, 'getApprovedTemplate').mockResolvedValue({
      providerTemplateId: 'tpl-cita', name: 'recordatorio_cita', variablesRequired: 3,
    });

    await expect(aiService.sendTemplateMessage(
      conversation._id,
      { id: 'tpl-cita', params: ['', '', ''] },
      actor,
      options('template-missing-date')
    )).rejects.toThrow('Completa la fecha y hora antes de enviar.');

    expect(await OutboundEvent.countDocuments({ conversation: conversation._id })).toBe(0);
    expect((await Conversation.findById(conversation._id)).messages).toHaveLength(0);
  });
  test('media manual usa el mismo OutboundEvent durable', async () => {
    const directSend = jest.spyOn(channelService, 'sendMedia');
    await aiService.sendMediaMessage(
      conversation._id,
      { mediaUrl: 'https://cdn.test/photo.jpg', mediaType: 'image', caption: 'Foto' },
      actor,
      options('media-1')
    );

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event.messageType).toBe('media');
    expect(event.payload.media).toEqual({ url: 'https://cdn.test/photo.jpg', type: 'image', caption: 'Foto' });
    expect(enqueueOutbound).toHaveBeenCalledWith(event._id);
    expect(directSend).not.toHaveBeenCalled();
  });

  test('dos requests con la misma idempotency key crean un evento y un mensaje', async () => {
    await aiService.sendAgentMessage(conversation._id, 'No duplicar', actor, options('same-request'));
    await aiService.sendAgentMessage(conversation._id, 'No duplicar', actor, options('same-request'));

    expect(await OutboundEvent.countDocuments({ conversation: conversation._id })).toBe(1);
    const stored = await Conversation.findById(conversation._id);
    expect(stored.messages.filter((item) => item.content === 'No duplicar')).toHaveLength(1);

    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      limits: { aiEnabled: false, whatsappEnabled: true, automationsEnabled: false },
    });
    const providerSend = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'provider-once' });
    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    const job = { data: { outboundEventId: event._id }, attemptsMade: 0, opts: { attempts: 3 } };
    await processOutboundJob(job);
    await processOutboundJob(job);
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  test('fallo recuperable pre-send reintenta el mismo evento manual y termina sent', async () => {
    await aiService.sendAgentMessage(conversation._id, 'Reintentar', actor, options('retry-manual'));
    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      limits: { aiEnabled: false, whatsappEnabled: true, automationsEnabled: false },
    });
    const providerSend = jest.spyOn(channelService, 'sendMessage')
      .mockRejectedValueOnce(Object.assign(new Error('conexión rechazada'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({ messageId: 'provider-after-retry' });

    await expect(processOutboundJob({ data: { outboundEventId: event._id }, attemptsMade: 0, opts: { attempts: 3 } }))
      .rejects.toThrow('conexión rechazada');
    expect((await OutboundEvent.findById(event._id)).status).toBe('retryable_failed');

    await processOutboundJob({ data: { outboundEventId: event._id }, attemptsMade: 1, opts: { attempts: 3 } });
    expect(providerSend).toHaveBeenCalledTimes(2);
    expect((await OutboundEvent.findById(event._id)).status).toBe('sent');
  });

  test('timeout ambiguo manual termina delivery_uncertain y un replay no reenvía', async () => {
    await aiService.sendAgentMessage(conversation._id, 'No duplicar por timeout', actor, options('timeout-manual'));
    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      limits: { aiEnabled: false, whatsappEnabled: true, automationsEnabled: false },
    });
    const providerSend = jest.spyOn(channelService, 'sendMessage').mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })
    );
    const job = { data: { outboundEventId: event._id }, attemptsMade: 0, opts: { attempts: 3 } };

    await processOutboundJob(job);
    await processOutboundJob(job);

    const storedEvent = await OutboundEvent.findById(event._id);
    const storedConversation = await Conversation.findById(conversation._id);
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(storedEvent.status).toBe('delivery_uncertain');
    expect(storedConversation.messages[0].whatsappStatus).toBe('delivery_uncertain');
  });

  test('conversation de Tenant A no puede enviarse usando Tenant B', async () => {
    await expect(aiService.sendAgentMessage(
      conversation._id,
      'No enviar',
      actor,
      { tenantId: new mongoose.Types.ObjectId(), idempotencyKey: 'cross-tenant' }
    )).rejects.toMatchObject({ statusCode: 404 });
    expect(await OutboundEvent.countDocuments({})).toBe(0);
  });

  test('canal cross-tenant se bloquea antes de crear OutboundEvent', async () => {
    const otherTenant = new mongoose.Types.ObjectId();
    const foreignChannel = await WhatsAppChannel.create({
      tenantId: otherTenant,
      businessId: otherTenant,
      provider: 'gupshup',
      phoneNumber: '+51922222222',
      phoneNumberId: `phone-${new mongoose.Types.ObjectId()}`,
      status: 'active',
      connectionType: 'PLATFORM',
    });
    conversation.whatsappChannel = foreignChannel._id;
    await conversation.save();

    await expect(aiService.sendAgentMessage(conversation._id, 'No enviar', actor, options('foreign-channel')))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await OutboundEvent.countDocuments({})).toBe(0);
  });

  test('canal desconectado falla explícitamente antes de crear OutboundEvent', async () => {
    channel.status = 'disconnected';
    await channel.save();

    await expect(aiService.sendAgentMessage(conversation._id, 'No enviar', actor, options('offline-channel')))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await OutboundEvent.countDocuments({})).toBe(0);
  });

  test.each([
    ['text', 'sendMessage', { text: 'Texto' }],
    ['template', 'sendTemplate', { template: { id: 'tpl', params: [] } }],
    ['media', 'sendMedia', { media: { url: 'https://cdn.test/x.jpg', type: 'image' } }],
  ])('worker entrega un evento manual %s por el provider correcto', async (messageType, method, payload) => {
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      limits: { aiEnabled: false, whatsappEnabled: true, automationsEnabled: false },
    });
    const providerSend = jest.spyOn(channelService, method).mockResolvedValue({ messageId: `provider-${messageType}` });
    const event = await OutboundEvent.create({
      channel: channel._id,
      tenantId,
      conversation: conversation._id,
      origin: 'manual',
      messageType,
      payload,
      to: lead.phone,
      text: 'Representación visible',
      status: 'queued',
    });

    await processOutboundJob({ data: { outboundEventId: event._id }, attemptsMade: 0, opts: { attempts: 3 } });

    expect(providerSend).toHaveBeenCalledTimes(1);
    expect((await OutboundEvent.findById(event._id)).status).toBe('sent');
  });
});
