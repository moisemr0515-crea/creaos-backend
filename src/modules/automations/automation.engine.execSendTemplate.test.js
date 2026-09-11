// Test real (Jest, Mongo real, channel.service.js mockeado) de
// automation.engine.js#execSendTemplate() — Caso 5 del backlog, PR A/6
// ("Seguimientos automáticos" de verdad). channelService se mockea con
// jest.mock() (no jest.spyOn) porque automation.engine.js lo importa como
// objeto completo — jest.mock() reemplaza el módulo ANTES de que
// automation.engine.js lo requiera, así que ambos apuntan al mismo mock,
// sin depender de Gupshup/Redis reales (mismo criterio ya establecido en
// inbound.worker.test.js/automationSweep.worker.test.js).
jest.mock('../channels/channel.service', () => ({
  getChannelForConversation: jest.fn(),
  sendMessage: jest.fn(),
  sendTemplate: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const channelService = require('../channels/channel.service');
const { execSendTemplate, executeAction } = require('./automation.engine');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_automation_send_template';

describe('automation.engine#execSendTemplate()', () => {
  let business;
  let lead;
  const FAKE_CHANNEL = { _id: new mongoose.Types.ObjectId() };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    lead = await Lead.create({ business: business._id, name: 'Lead de prueba', phone: '+51999999999' });

    channelService.getChannelForConversation.mockResolvedValue(FAKE_CHANNEL);
    channelService.sendMessage.mockResolvedValue({ messageId: 'msg-1' });
    channelService.sendTemplate.mockResolvedValue({ messageId: 'tpl-1' });
  });

  test('lead sin teléfono falla antes de tocar conversación/canal', async () => {
    const sinTelefono = await Lead.create({ business: business._id, name: 'Sin teléfono' });

    await expect(execSendTemplate({ templateId: 'tpl_x' }, sinTelefono)).rejects.toThrow(
      /no tiene un número de teléfono/
    );
    expect(channelService.getChannelForConversation).not.toHaveBeenCalled();
  });

  test('ventana cerrada (lead sin conversación previa) + templateId → manda plantilla, no texto', async () => {
    const resultado = await execSendTemplate(
      { templateId: 'tpl_seguimiento', templateParams: ['Juan'] },
      lead
    );

    expect(channelService.sendTemplate).toHaveBeenCalledWith(FAKE_CHANNEL._id, lead.phone, {
      id: 'tpl_seguimiento',
      params: ['Juan'],
    });
    expect(channelService.sendMessage).not.toHaveBeenCalled();
    expect(resultado).toEqual({ conversationId: expect.anything(), sentVia: 'template', templateId: 'tpl_seguimiento' });

    const conv = await Conversation.findOne({ lead: lead._id });
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].sentBy).toBe('automation');
    expect(conv.messages[0].whatsappStatus).toBe('sent');
    expect(conv.messages[0].metadata.isTemplate).toBe(true);
    expect(conv.messages[0].metadata.templateId).toBe('tpl_seguimiento');
  });

  test('NO apaga aiEnabled — a diferencia del envío manual de un agente (sendTemplateMessage())', async () => {
    await execSendTemplate({ templateId: 'tpl_seguimiento' }, lead);

    const conv = await Conversation.findOne({ lead: lead._id });
    expect(conv.aiEnabled).toBe(true);
  });

  test('ventana abierta (lastInboundMessageAt reciente) + config.text → manda texto libre, ignora templateId', async () => {
    await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      status: 'active',
      lastInboundMessageAt: new Date(), // ventana recién abierta
    });

    const resultado = await execSendTemplate(
      { text: '¿Seguimos en contacto?', templateId: 'tpl_seguimiento' },
      lead
    );

    expect(channelService.sendMessage).toHaveBeenCalledWith(FAKE_CHANNEL._id, lead.phone, '¿Seguimos en contacto?');
    expect(channelService.sendTemplate).not.toHaveBeenCalled();
    expect(resultado.sentVia).toBe('text');
  });

  test('ventana cerrada y sin templateId configurado → falla con mensaje claro, no llama a channelService', async () => {
    await expect(execSendTemplate({}, lead)).rejects.toThrow(/ventana de 24h de WhatsApp está cerrada/);

    expect(channelService.sendTemplate).not.toHaveBeenCalled();
    expect(channelService.sendMessage).not.toHaveBeenCalled();

    // La conversación se crea igual (lazy, mismo criterio que
    // execStartAIConversation()) pero sin ningún mensaje — el envío nunca
    // se intentó.
    const conv = await Conversation.findOne({ lead: lead._id });
    expect(conv).not.toBeNull();
    expect(conv.messages).toHaveLength(0);
  });

  test('sin WhatsAppChannel activo → falla con mensaje claro', async () => {
    channelService.getChannelForConversation.mockResolvedValue(null);

    await expect(execSendTemplate({ templateId: 'tpl_x' }, lead)).rejects.toThrow(
      /no hay un WhatsAppChannel activo/
    );
  });

  test('si el envío real falla, guarda el mensaje como failed en la conversación Y relanza el error', async () => {
    channelService.sendTemplate.mockRejectedValue(new Error('Gupshup: plantilla no aprobada'));

    await expect(execSendTemplate({ templateId: 'tpl_x' }, lead)).rejects.toThrow('Gupshup: plantilla no aprobada');

    const conv = await Conversation.findOne({ lead: lead._id });
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].whatsappStatus).toBe('failed');
    expect(conv.messages[0].whatsappError).toBe('Gupshup: plantilla no aprobada');
  });

  test('reusa una conversación "active" existente en vez de crear una nueva', async () => {
    const existente = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      status: 'active',
    });

    await execSendTemplate({ templateId: 'tpl_x' }, lead);

    const total = await Conversation.countDocuments({ lead: lead._id });
    expect(total).toBe(1);
    const conv = await Conversation.findById(existente._id);
    expect(conv.messages).toHaveLength(1);
  });

  test('una conversación existente de otro canal (no whatsapp) falla con mensaje claro', async () => {
    await Conversation.create({ business: business._id, lead: lead._id, channel: 'web', status: 'active' });

    await expect(execSendTemplate({ templateId: 'tpl_x' }, lead)).rejects.toThrow(/no es por WhatsApp/);
  });

  test('executeAction() enruta "send_template" a execSendTemplate()', async () => {
    const resultado = await executeAction({ type: 'send_template', config: { templateId: 'tpl_x' } }, lead);
    expect(channelService.sendTemplate).toHaveBeenCalledTimes(1);
    expect(resultado.sentVia).toBe('template');
  });
});
