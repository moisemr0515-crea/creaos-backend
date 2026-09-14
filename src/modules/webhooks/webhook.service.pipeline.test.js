// Test real (Jest, Mongo real) del incidente de producción del 11/sep/2026
// (docs/implementation/known-issues.md): processGupshupMessage() (el
// handler real de WhatsApp entrante en producción hoy) y
// processWhatsAppMessage() creaban leads sin `pipeline` seteado —
// invisibles en Pipeline (GET /pipeline/:id/board, $match por
// pipeline._id). No existía ningún test dedicado de webhook.service.js
// hasta ahora (la única cobertura previa, webhook.controller.test.js,
// prueba otra cosa — interceptación de account-events). Este archivo
// cubre solo el fix puntual, no reprueba el resto de cada función
// (respuesta de IA, notificaciones, etc. — fuera de alcance de este PR).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const WebhookConfig = require('./webhookConfig.model');
const aiService = require('../ai/ai.service');
const channelService = require('../channels/channel.service');
const subscriptionService = require('../subscriptions/subscription.service');
const { processGupshupMessage, processWhatsAppMessage } = require('./webhook.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_webhook_service_pipeline';

describe('webhook.service — leads de WhatsApp entrante quedan con pipeline seteado', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await WebhookConfig.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      planName: 'closer', limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    });
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await WebhookConfig.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });

    // Mockeado para que processGupshupMessage() no llegue a intentar una
    // respuesta real de IA/WhatsApp — fuera de alcance de este test,
    // acotado al fix de `pipeline`. getChannelForConversation():null hace
    // que la función corte ahí (mismo camino que "sin WhatsAppChannel
    // activo", ya cubierto por su propio logging, no por tests de este
    // archivo).
    jest.spyOn(aiService, 'saveInboundMessage').mockResolvedValue(undefined);
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: 'hola' });
    jest.spyOn(channelService, 'getChannelForConversation').mockResolvedValue(null);
  });

  test('processGupshupMessage(): un lead nuevo por WhatsApp entrante queda con pipeline seteado al default del negocio', async () => {
    await processGupshupMessage({ phone: '+51900000001', text: 'Hola, quiero info' }, business._id.toString());

    const pipeline = await Pipeline.findOne({ business: business._id, isDefault: true, isActive: true });
    expect(pipeline).not.toBeNull();

    const lead = await Lead.findOne({ business: business._id, phone: '+51900000001' });
    expect(lead.pipeline?.toString()).toBe(pipeline._id.toString());
  });

  test('processGupshupMessage(): un lead YA existente (sin pipeline, de antes de este fix) no se toca — el fix es solo para leads NUEVOS', async () => {
    const leadViejo = await Lead.create({ business: business._id, name: 'Lead viejo', phone: '+51900000002', source: 'whatsapp' });
    expect(leadViejo.pipeline).toBeUndefined();

    await processGupshupMessage({ phone: '+51900000002', text: 'Otro mensaje' }, business._id.toString());

    const leadActualizado = await Lead.findById(leadViejo._id);
    expect(leadActualizado.pipeline).toBeUndefined(); // sigue sin pipeline — lo resuelve el backfill (parte 2), no este fix
  });

  test('processWhatsAppMessage(): un lead nuevo (canal Meta/Cloud API) queda con pipeline seteado al default del negocio', async () => {
    const config = await WebhookConfig.create({ business: business._id, platform: 'meta', pageId: 'phone-number-id-123', isActive: true });

    await processWhatsAppMessage({ phoneNumberId: 'phone-number-id-123', from: '+51900000003', name: 'Lead Meta', text: 'Hola' });

    const pipeline = await Pipeline.findOne({ business: business._id, isDefault: true, isActive: true });
    expect(pipeline).not.toBeNull();

    const lead = await Lead.findOne({ business: config.business, phone: '+51900000003' });
    expect(lead.pipeline?.toString()).toBe(pipeline._id.toString());
  });
});
