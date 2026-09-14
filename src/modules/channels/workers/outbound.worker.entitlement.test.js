const mongoose = require('mongoose');
const OutboundEvent = require('../outboundEvent.model');
const channelService = require('../channel.service');
const subscriptionService = require('../../subscriptions/subscription.service');
const Conversation = require('../../ai/conversation.model');
const { processOutboundJob } = require('./outbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_outbound_entitlement_p1';

describe('outbound worker — entitlement P1-1', () => {
  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  test('Starter no envía una respuesta automática aunque incluya IA asistida y WhatsApp', async () => {
    await mongoose.connection.dropDatabase();
    const sendMessage = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'unexpected' });
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      planName: 'starter',
      limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: false },
    });
    const id = () => new mongoose.Types.ObjectId();
    const tenantId = id();
    const channelId = id();
    const conversation = await Conversation.create({ business: tenantId, tenantId, lead: id(), channel: 'whatsapp', whatsappChannel: channelId, aiEnabled: true });
    const event = await OutboundEvent.create({
      channel: channelId, tenantId, conversation: conversation._id, to: '51900000000', text: 'Respuesta automática',
    });

    await processOutboundJob({ data: { outboundEventId: event._id } });

    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('rechaza una conversación de otro tenant aunque el channelId del evento sea conocido', async () => {
    await mongoose.connection.dropDatabase();
    const sendMessage = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'unexpected' });
    const id = () => new mongoose.Types.ObjectId();
    const channelId = id();
    const conversation = await Conversation.create({ business: id(), lead: id(), channel: 'whatsapp', whatsappChannel: channelId, aiEnabled: true });
    const event = await OutboundEvent.create({ channel: channelId, tenantId: id(), conversation: conversation._id, to: '51900000000', text: 'No enviar' });
    await expect(processOutboundJob({ data: { outboundEventId: event._id } })).rejects.toThrow(/fuera del tenant/);
    expect((await OutboundEvent.findById(event._id)).status).toBe('permanently_failed');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('rechaza un canal distinto del canal original de la conversación', async () => {
    await mongoose.connection.dropDatabase();
    const sendMessage = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'unexpected' });
    const id = () => new mongoose.Types.ObjectId();
    const tenantId = id();
    const conversation = await Conversation.create({ business: tenantId, lead: id(), channel: 'whatsapp', whatsappChannel: id(), aiEnabled: true });
    const event = await OutboundEvent.create({ channel: id(), tenantId, conversation: conversation._id, to: '51900000000', text: 'No enviar' });
    await expect(processOutboundJob({ data: { outboundEventId: event._id } })).rejects.toThrow(/canal original inconsistente/);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
