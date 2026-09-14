// Test real (Jest, Mongo real) de webhook.service.js#processGupshupMessage()
// — CREA SALES AI™ C.3, Etapa C3.3 (Action Outcomes). Mockea
// aiService.runAgent() directamente (no generateReply() ni OpenAI) porque
// el foco acá es la reacción de processGupshupMessage() ante
// outcome:'error' — el comportamiento real de runAgent() en sí ya está
// cubierto en ai.service.runAgent.test.js.
//
// Contexto del cambio: desde la Etapa C3.3, runAgent() ya NO deja
// propagar una excepción cruda de generateReply() — la normaliza a
// outcome:'error'. Sin el fix que se prueba acá, processGupshupMessage()
// seguiría de largo con reply:undefined como si el agente hubiera
// decidido legítimamente no responder, y el InboundEvent correspondiente
// (inbound.gateway.js#handleOne()) quedaría marcado 'processed' en vez de
// 'failed' — perdiendo la señal de que algo salió mal.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const aiService = require('../ai/ai.service');
const channelService = require('../channels/channel.service');
const subscriptionService = require('../subscriptions/subscription.service');
const { processGupshupMessage } = require('./webhook.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_webhook_service_run_agent_outcome';

describe('webhook.service#processGupshupMessage() — reacción a outcome:"error" de runAgent() (C.3, Etapa C3.3)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
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
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });

    jest.spyOn(aiService, 'saveInboundMessage').mockResolvedValue(undefined);
    jest.spyOn(channelService, 'getChannelForConversation').mockResolvedValue(null);
  });

  test('outcome:"error" → processGupshupMessage() LANZA (preserva que inbound.gateway.js marque el InboundEvent como "failed")', async () => {
    jest.spyOn(aiService, 'runAgent').mockResolvedValue({
      outcome: 'error',
      responseText: null,
      toolsUsed: [],
      knowledgeSources: [],
      correlationId: 'run-de-prueba',
      tokensUsed: 0,
      errorCode: 'El agente no pudo completar la respuesta (demasiadas tool calls encadenadas)',
    });

    await expect(
      processGupshupMessage({ phone: '+51900000010', text: 'Hola' }, business._id.toString())
    ).rejects.toThrow(/demasiadas tool calls encadenadas/);
  });

  test('outcome:"answer" → sigue funcionando igual que antes de C3.3 (no lanza, no manda nada por no haber WhatsAppChannel activo)', async () => {
    jest.spyOn(aiService, 'runAgent').mockResolvedValue({
      outcome: 'answer',
      responseText: 'Hola, ¿en qué te ayudo?',
      toolsUsed: [],
      knowledgeSources: [],
      correlationId: 'run-de-prueba-2',
      tokensUsed: 15,
    });

    await expect(
      processGupshupMessage({ phone: '+51900000011', text: 'Hola' }, business._id.toString())
    ).resolves.toBeDefined();
  });
});
