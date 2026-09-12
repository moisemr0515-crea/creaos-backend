// Test real (Jest, Mongo real) de ai.service.js#generateReply() —
// reconstrucción de la ventana de mensajes recientes para un turno NUEVO
// (construirVentanaDeMensajes(), ver ai.service.js). Reproduce el escenario
// exacto encontrado auditando el código real para CREA Product
// Intelligence™ V1.0 (Etapa 6): un mensaje role:'tool' que cae justo en el
// borde del corte de los últimos 10 mensajes, sin el mensaje assistant que
// originó su tool_call dentro de la misma ventana. Antes de este fix, ese
// mensaje se mandaba a OpenAI sin `tool_call_id` — la API real rechaza eso
// con 400 ("messages with role 'tool' must be a response to a preceding
// message with 'tool_calls'"). openai.chat.completions.create() se mockea
// (no se puede reproducir el 400 real sin pegarle a la API) — lo que se
// prueba acá es el PAYLOAD que generateReply() arma y manda, que es
// exactamente donde vivía el bug.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_tool_history_window';

const mockCompletion = (content = 'Respuesta final de la IA.') => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe('ai.service#generateReply() — ventana de mensajes recientes y tool-calling', () => {
  let business;
  let lead;

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
    jest.restoreAllMocks();
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
  });

  test('mensaje tool huérfano justo en el borde del corte de 10: se descarta, OpenAI nunca recibe un tool sin tool_call_id válido', async () => {
    const conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' },
        { role: 'user', content: '¿Tienen moringa?' },
        // Posición -11 sobre el total final (14) — FUERA de la ventana de 10.
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_abc', type: 'function', function: { name: 'search_products', arguments: '{"query":"moringa"}' } }],
        },
        // Posición -10 — primer elemento de la ventana: huérfano, porque el
        // assistant de arriba (su tool_calls) quedó justo afuera del corte.
        {
          role: 'tool',
          content: JSON.stringify({ success: true, matches: [{ productId: new mongoose.Types.ObjectId(), name: 'Moringa' }] }),
          toolCallId: 'call_abc',
          name: 'search_products',
        },
        // Relleno hasta completar 14 mensajes en total, terminando en el
        // mensaje nuevo del lead que dispara este generateReply() (según su
        // propio contrato: asume que ya está guardado antes de llamarlo).
        { role: 'user', content: '¿Y en pastillas?' },
        { role: 'assistant', content: 'Sí, en cápsulas de 100.' },
        { role: 'user', content: '¿Hacen envíos?' },
        { role: 'assistant', content: 'Sí, a todo el país.' },
        { role: 'user', content: '¿Cuánto tarda?' },
        { role: 'assistant', content: 'Entre 2 y 5 días.' },
        { role: 'user', content: '¿Puedo pagar contra entrega?' },
        { role: 'assistant', content: 'Sí, aceptamos contra entrega.' },
        { role: 'user', content: 'Dale, ¿me confirmás el precio de la moringa?' },
      ],
    });
    expect(conversation.messages).toHaveLength(14);

    const createSpy = jest
      .spyOn(aiService.openai.chat.completions, 'create')
      .mockResolvedValue(mockCompletion());

    const resultado = await aiService.generateReply(conversation._id, business, lead);

    expect(resultado.reply).toBe('Respuesta final de la IA.');
    expect(createSpy).toHaveBeenCalledTimes(1);

    const mensajesEnviados = createSpy.mock.calls[0][0].messages;

    // El mensaje 'tool' huérfano (toolCallId 'call_abc') NUNCA debe llegar a
    // OpenAI.
    expect(mensajesEnviados.some((m) => m.role === 'tool' && m.tool_call_id === 'call_abc')).toBe(false);

    // Verificación genérica (la validación real que hace la API de OpenAI):
    // ningún mensaje role:'tool' enviado puede faltar tool_call_id, y para
    // cada uno tiene que existir un assistant anterior con ese mismo id
    // dentro de su tool_calls.
    const idsConToolCall = new Set(
      mensajesEnviados.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls.map((tc) => tc.id))
    );
    for (const m of mensajesEnviados) {
      if (m.role === 'tool') {
        expect(m.tool_call_id).toBeTruthy();
        expect(idsConToolCall.has(m.tool_call_id)).toBe(true);
      }
    }
  });

  test('intercambio de tool-calling completo DENTRO de la ventana de 10: tool_calls/tool_call_id llegan íntegros a OpenAI', async () => {
    const conversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [
        { role: 'user', content: 'Hola' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_xyz', type: 'function', function: { name: 'search_products', arguments: '{"query":"aceite"}' } }],
        },
        {
          role: 'tool',
          content: JSON.stringify({ success: true, matches: [] }),
          toolCallId: 'call_xyz',
          name: 'search_products',
        },
        { role: 'assistant', content: 'No encontré ese producto en el catálogo.' },
        { role: 'user', content: 'Ah, dale, gracias.' },
      ],
    });

    jest.spyOn(aiService.openai.chat.completions, 'create').mockResolvedValue(mockCompletion());

    await aiService.generateReply(conversation._id, business, lead);

    const mensajesEnviados = aiService.openai.chat.completions.create.mock.calls[0][0].messages;

    const assistantConTool = mensajesEnviados.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantConTool.tool_calls).toEqual([
      { id: 'call_xyz', type: 'function', function: { name: 'search_products', arguments: '{"query":"aceite"}' } },
    ]);

    const toolMsg = mensajesEnviados.find((m) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_xyz');
  });
});
