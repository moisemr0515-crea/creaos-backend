const mongoose = require('mongoose');
const OutboundEvent = require('../outboundEvent.model');
const channelService = require('../channel.service');
const subscriptionService = require('../../subscriptions/subscription.service');
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
    const event = await OutboundEvent.create({
      channel: id(), tenantId: id(), conversation: id(), to: '51900000000', text: 'Respuesta automática',
    });

    await processOutboundJob({ data: { outboundEventId: event._id } });

    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('skipped');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
