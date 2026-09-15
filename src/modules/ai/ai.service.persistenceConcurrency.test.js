const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_persistence_concurrency';

const completion = (content, tokens = 5) => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: tokens - 2, completion_tokens: 2, total_tokens: tokens },
});

describe('ai.service — persistencia concurrente y memoria de largo plazo', () => {
  let business;
  let lead;

  beforeAll(async () => mongoose.connect(MONGO_URI));

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await mongoose.connection.dropDatabase();
    business = await Business.create({ name: 'Negocio concurrente' });
    lead = await Lead.create({ business: business._id, name: 'Lead concurrente' });
  });

  const createConversation = (messages = []) => Conversation.create({
    business: business._id,
    lead: lead._id,
    channel: 'whatsapp',
    messages,
  });

  test('dos mensajes entrantes simultáneos distintos quedan persistidos sin sobrescribirse', async () => {
    const conversation = await createConversation();

    await Promise.all([
      aiService.saveInboundMessage(conversation._id, 'Mensaje A', undefined, { providerMessageId: 'wamid-a' }),
      aiService.saveInboundMessage(conversation._id, 'Mensaje B', undefined, { providerMessageId: 'wamid-b' }),
    ]);

    const saved = await Conversation.findById(conversation._id).lean();
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages.map((message) => message.content).sort()).toEqual(['Mensaje A', 'Mensaje B']);
  });

  test('dos entregas simultáneas con el mismo providerMessageId se guardan una sola vez', async () => {
    const conversation = await createConversation();

    await Promise.all([
      aiService.saveInboundMessage(conversation._id, 'Duplicado', undefined, { providerMessageId: 'wamid-same' }),
      aiService.saveInboundMessage(conversation._id, 'Duplicado', undefined, { providerMessageId: 'wamid-same' }),
    ]);

    const saved = await Conversation.findById(conversation._id).lean();
    expect(saved.messages).toHaveLength(1);
    expect(saved.messages[0].metadata.providerMessageId).toBe('wamid-same');
  });

  test('dos respuestas IA simultáneas se anexan y acumulan tokens sin perder ninguna', async () => {
    const conversation = await createConversation([{ role: 'user', content: 'Hola' }]);
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    jest.spyOn(aiService.openai.chat.completions, 'create').mockImplementation(async () => {
      calls += 1;
      if (calls === 2) release();
      await barrier;
      return completion(`Respuesta ${calls}`, 5);
    });

    await Promise.all([
      aiService.generateReply(conversation._id, business, lead),
      aiService.generateReply(conversation._id, business, lead),
    ]);

    const saved = await Conversation.findById(conversation._id).lean();
    const assistantMessages = saved.messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(saved.totalTokensUsed).toBe(10);
  });

  test('un summary persistido se incluye como memoria separada de los mensajes recientes', async () => {
    const conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      summary: 'El lead necesita entrega antes del viernes.',
      summaryThroughMessageCount: 2,
      messages: [
        { role: 'user', content: 'Mensaje anterior' },
        { role: 'assistant', content: 'Respuesta anterior' },
        { role: 'user', content: '¿Qué opciones tengo?' },
      ],
    });
    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create')
      .mockResolvedValue(completion('Estas son las opciones.', 5));

    await aiService.generateReply(conversation._id, business, lead);

    const sentMessages = createSpy.mock.calls[0][0].messages;
    expect(sentMessages).toContainEqual({
      role: 'system',
      content: expect.stringContaining('El lead necesita entrega antes del viernes.'),
    });
  });

  test('al acumular diez mensajes fuera de la ventana reciente refresca y persiste la memoria incremental', async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Mensaje ${index + 1}`,
    }));
    const conversation = await createConversation(messages);
    const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create')
      .mockResolvedValueOnce(completion('Memoria consolidada.', 7))
      .mockResolvedValueOnce(completion('Respuesta final.', 5));

    await aiService.generateReply(conversation._id, business, lead);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[1][0].messages).toContainEqual({
      role: 'system',
      content: expect.stringContaining('Memoria consolidada.'),
    });
    const saved = await Conversation.findById(conversation._id).lean();
    expect(saved.summary).toBe('Memoria consolidada.');
    expect(saved.summaryThroughMessageCount).toBe(10);
    expect(saved.messages).toHaveLength(21);
    expect(saved.totalTokensUsed).toBe(12);
  });
});
