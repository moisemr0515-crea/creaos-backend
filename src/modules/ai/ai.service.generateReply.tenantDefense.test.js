const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tenant_defense';

const completionFinal = (content = 'Respuesta segura') => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const crearContexto = async ({ withTenantId = true, withChannel = false } = {}) => {
  const business = await Business.create({ name: 'Negocio seguro' });
  const lead = await Lead.create({ business: business._id, name: 'Lead seguro' });
  let channel = null;

  if (withChannel) {
    channel = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      phoneNumber: '+51900000001',
      phoneNumberId: `phone-${new mongoose.Types.ObjectId()}`,
      connectionType: 'PLATFORM',
      status: 'active',
    });
  }

  const conversation = await Conversation.create({
    business: business._id,
    ...(withTenantId ? { tenantId: business._id } : {}),
    lead: lead._id,
    channel: 'whatsapp',
    whatsappChannel: channel?._id || null,
    messages: [{ role: 'user', content: 'Hola' }],
  });

  return { business, lead, channel, conversation };
};

describe('ai.service#generateReply() — defensa multi-tenant interna', () => {
  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
  });

  test('Conversation, Lead, Business y WhatsAppChannel del mismo tenant funcionan con la firma actual', async () => {
    const { business, lead, conversation } = await crearContexto({ withChannel: true });
    jest.spyOn(aiService.openai.chat.completions, 'create').mockResolvedValueOnce(completionFinal());

    await expect(aiService.generateReply(conversation._id, business, lead)).resolves.toMatchObject({
      reply: 'Respuesta segura',
    });
  });

  test('Conversation de tenant A con expected Business de tenant B se bloquea antes de OpenAI', async () => {
    const { lead, conversation } = await crearContexto();
    const businessB = await Business.create({ name: 'Negocio B' });
    const openaiSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    await expect(aiService.generateReply(conversation._id, businessB, lead)).rejects.toMatchObject({
      statusCode: 500,
      message: 'Inconsistencia interna de aislamiento de tenant',
    });
    expect(openaiSpy).not.toHaveBeenCalled();
  });

  test('Lead persistido en otro tenant se bloquea aunque el caller intente asociarlo a la conversación', async () => {
    const { business, conversation } = await crearContexto();
    const businessB = await Business.create({ name: 'Negocio B' });
    const leadB = await Lead.create({ business: businessB._id, name: 'Lead B' });
    conversation.lead = leadB._id;
    await conversation.save();
    const openaiSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    await expect(aiService.generateReply(conversation._id, business, leadB)).rejects.toMatchObject({ statusCode: 500 });
    expect(openaiSpy).not.toHaveBeenCalled();
  });

  test('WhatsAppChannel de otro tenant se bloquea antes de generar o ejecutar tools', async () => {
    const { business, lead, conversation } = await crearContexto();
    const businessB = await Business.create({ name: 'Negocio B' });
    const channelB = await WhatsAppChannel.create({
      tenantId: businessB._id,
      businessId: businessB._id,
      provider: 'gupshup',
      phoneNumber: '+51900000002',
      phoneNumberId: `phone-${new mongoose.Types.ObjectId()}`,
      connectionType: 'PLATFORM',
      status: 'active',
    });
    conversation.whatsappChannel = channelB._id;
    await conversation.save();
    const openaiSpy = jest.spyOn(aiService.openai.chat.completions, 'create');

    await expect(aiService.generateReply(conversation._id, business, lead)).rejects.toMatchObject({ statusCode: 500 });
    expect(openaiSpy).not.toHaveBeenCalled();
  });

  test('conversación histórica válida sin tenantId ni whatsappChannel continúa funcionando', async () => {
    const { business, lead, conversation } = await crearContexto({ withTenantId: false, withChannel: false });
    jest.spyOn(aiService.openai.chat.completions, 'create').mockResolvedValueOnce(completionFinal('Histórico compatible'));

    await expect(aiService.generateReply(conversation._id, business, lead)).resolves.toMatchObject({
      reply: 'Histórico compatible',
    });
  });
});
