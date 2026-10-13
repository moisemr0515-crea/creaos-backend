const mongoose = require('mongoose');
const OutboundEvent = require('../outboundEvent.model');
const Conversation = require('../../ai/conversation.model');
const WhatsAppConsent = require('../../whatsappConsent/whatsappConsent.model');
const channelService = require('../channel.service');
const subscriptionService = require('../../subscriptions/subscription.service');
const { processOutboundJob } = require('./outbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_outbound_consent_c003';

describe('outbound worker — enforcement C-003', () => {
  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.restoreAllMocks();
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      planName: 'dominator',
      limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    });
  });

  async function createEvent({ intent, status, origin }) {
    const tenantId = new mongoose.Types.ObjectId();
    const channelId = new mongoose.Types.ObjectId();
    const phone = '+51922222222';
    const conversation = await Conversation.create({
      business: tenantId,
      tenantId,
      lead: new mongoose.Types.ObjectId(),
      channel: 'whatsapp',
      whatsappChannel: channelId,
      aiEnabled: true,
    });
    if (status) {
      await WhatsAppConsent.create({
        tenantId,
        phone,
        status,
        source: status === 'OPTED_OUT' ? 'user_message' : 'web_form',
        purpose: 'marketing',
        grantedAt: status === 'OPTED_IN' ? new Date() : null,
        revokedAt: status === 'OPTED_OUT' ? new Date() : null,
      });
    }
    const event = await OutboundEvent.create({
      channel: channelId,
      tenantId,
      conversation: conversation._id,
      to: phone,
      text: 'Mensaje',
      origin: origin || (intent === 'ai_automated' ? 'ai' : 'manual'),
      messageIntent: intent,
    });
    return event;
  }

  test('bloquea marketing sin opt-in antes de llamar al proveedor', async () => {
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'no' });
    const event = await createEvent({ intent: 'commercial' });
    await processOutboundJob({ data: { outboundEventId: event._id } });
    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('skipped');
    expect(stored.errorType).toBe('whatsapp_consent_required');
    expect(send).not.toHaveBeenCalled();
  });

  test('bloquea marketing suprimido y permite marketing con opt-in explícito', async () => {
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'sent-1' });
    const suppressed = await createEvent({ intent: 'marketing', status: 'OPTED_OUT' });
    await processOutboundJob({ data: { outboundEventId: suppressed._id } });
    expect((await OutboundEvent.findById(suppressed._id)).errorType).toBe('whatsapp_suppressed');
    expect(send).not.toHaveBeenCalled();

    const optedIn = await createEvent({ intent: 'commercial', status: 'OPTED_IN' });
    await processOutboundJob({ data: { outboundEventId: optedIn._id } });
    expect((await OutboundEvent.findById(optedIn._id)).status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('una respuesta reactiva sigue saliendo aunque exista baja comercial', async () => {
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'reactive-1' });
    const event = await createEvent({ intent: 'reactive', status: 'OPTED_OUT' });
    await processOutboundJob({ data: { outboundEventId: event._id } });
    expect((await OutboundEvent.findById(event._id)).status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('una respuesta IA automática queda bloqueada con OPTED_OUT aunque sea posterior a un inbound', async () => {
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'no-debe-salir' });
    const event = await createEvent({ intent: 'ai_automated', status: 'OPTED_OUT' });
    await processOutboundJob({ data: { outboundEventId: event._id } });
    const stored = await OutboundEvent.findById(event._id);
    expect(stored.status).toBe('skipped');
    expect(stored.errorType).toBe('whatsapp_suppressed');
    expect(send).not.toHaveBeenCalled();
  });

  test('un evento IA legacy marcado reactive no hereda la excepción manual', async () => {
    const send = jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'no-debe-salir' });
    const event = await createEvent({ intent: 'reactive', status: 'OPTED_OUT', origin: 'ai' });
    await processOutboundJob({ data: { outboundEventId: event._id } });
    expect((await OutboundEvent.findById(event._id)).errorType).toBe('whatsapp_suppressed');
    expect(send).not.toHaveBeenCalled();
  });
});
