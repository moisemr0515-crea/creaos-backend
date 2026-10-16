// HOTFIX P0 — «la IA deja de responder para siempre tras enviar media».
// Causa: send_media / send_product_photos (adjunto) y escalate_to_human (nota de sistema) agregan su PROPIO mensaje a la
// conversación mientras corren, así que el historial guardado quedaba [assistant(tool_calls), adjunto, tool(resultado)]
// y OpenAI respondía 400 «An assistant message with 'tool_calls' must be followed by tool messages…» en cada turno
// siguiente. Estos tests usan un mock ESTRICTO que replica esa validación de OpenAI. Dos negocios, sin casos especiales.

// Credenciales FALSAS de Cloudinary (la firma de URLs es local): se fuerzan para no usar las del entorno.
process.env.CLOUDINARY_CLOUD_NAME = 'cloud-de-prueba';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'secreto-de-prueba';

jest.mock('../channels/queues/outbound.queue', () => ({ enqueueOutbound: jest.fn(), getOutboundQueue: jest.fn() }));

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('./conversation.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const logger = require('../../utils/logger');
const aiService = require('./ai.service');

const { construirVentanaDeMensajes } = aiService;

// ── Mock estricto de la validación de mensajes de OpenAI ──────────────────────────────────────────────────────────
const errorOpenAI400 = (mensaje) => Object.assign(new Error(`400 ${mensaje}`), { status: 400, name: 'BadRequestError' });

const validarComoOpenAI = (messages) => {
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls) {
      if (m.tool_calls.length === 0) throw errorOpenAI400("Invalid 'messages': empty array. Expected an array with minimum length 1 for 'tool_calls'.");
      const pendientes = new Set(m.tool_calls.map((tc) => tc.id));
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) pendientes.delete(messages[j].tool_call_id);
      if (pendientes.size) {
        throw errorOpenAI400(`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${[...pendientes].join(', ')}`);
      }
    }
    if (m.role === 'tool') {
      let k = i - 1;
      while (k >= 0 && messages[k].role === 'tool') k -= 1;
      const previo = messages[k];
      if (!(previo?.role === 'assistant' && previo.tool_calls?.some((tc) => tc.id === m.tool_call_id))) {
        throw errorOpenAI400("Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.");
      }
    }
  });
};

const llamadaATool = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const completion = (message) => ({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const pideTool = (...llamadas) => completion({ content: null, tool_calls: llamadas });
const responde = (texto) => completion({ content: texto, tool_calls: undefined });

describe('el mock estricto detecta el historial envenenado (control del propio test)', () => {
  const call = llamadaATool('c1', 'x');
  test.each([
    ['tool_calls sin resultado', [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'user', content: 'hola' }]],
    ['mensaje intercalado entre la llamada y su resultado', [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'assistant', content: '[Video]' }, { role: 'tool', tool_call_id: 'c1', content: '{}' }]],
    ['resultado huérfano', [{ role: 'user', content: 'hola' }, { role: 'tool', tool_call_id: 'c1', content: '{}' }]],
  ])('%s ⇒ 400', (_n, messages) => expect(() => validarComoOpenAI(messages)).toThrow(/400/));

  test('historial correcto ⇒ pasa', () => {
    expect(() => validarComoOpenAI([{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: '{}' }, { role: 'assistant', content: 'listo' }])).not.toThrow();
  });
});

// ── Saneador puro ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('construirVentanaDeMensajes — saneador del historial que va al modelo', () => {
  const c1 = llamadaATool('c1', 'send_media');
  const c2 = llamadaATool('c2', 'search_products');
  const llamada = (calls, content = '') => ({ role: 'assistant', content, toolCalls: calls });
  const resultado = (id) => ({ role: 'tool', content: '{"success":true}', toolCallId: id, name: 'x' });
  const usuario = (t) => ({ role: 'user', content: t });
  const asistente = (t, extra = {}) => ({ role: 'assistant', content: t, ...extra });
  const forma = (msgs) => construirVentanaDeMensajes(msgs, 20).map((m) => (m.role === 'tool' ? `tool:${m.tool_call_id}` : m.tool_calls ? `call:${m.tool_calls.map((t) => t.id)}` : `${m.role}:${m.content}`));

  test('historial correcto no cambia', () => {
    const msgs = [usuario('a'), llamada([c1]), resultado('c1'), asistente('listo'), usuario('b')];
    expect(forma(msgs)).toEqual(['user:a', 'call:c1', 'tool:c1', 'assistant:listo', 'user:b']);
    expect(() => validarComoOpenAI(construirVentanaDeMensajes(msgs, 20))).not.toThrow();
  });

  test('resultado separado de su llamada por el adjunto (datos ya guardados) ⇒ se pega a su llamada', () => {
    const msgs = [usuario('a'), llamada([c1]), asistente('[Video]', { mediaUrl: 'https://x.test/v.mp4' }), resultado('c1'), asistente('listo'), usuario('b')];
    expect(forma(msgs)).toEqual(['user:a', 'call:c1', 'tool:c1', 'assistant:[Video]', 'assistant:listo', 'user:b']);
    expect(() => validarComoOpenAI(construirVentanaDeMensajes(msgs, 20))).not.toThrow();
  });

  test('llamada sin resultado ⇒ se elimina (y su texto, si lo tiene, se conserva como mensaje normal)', () => {
    expect(forma([usuario('a'), llamada([c1]), usuario('b')])).toEqual(['user:a', 'user:b']);
    expect(forma([usuario('a'), llamada([c1], 'Déjame revisar'), usuario('b')])).toEqual(['user:a', 'assistant:Déjame revisar', 'user:b']);
  });

  test('resultado guardado como mensaje del contacto ⇒ la llamada queda sin pareja y se elimina; el resto no se rompe', () => {
    const msgs = [usuario('a'), llamada([c1]), usuario('{"success":true,"status":"queued"}'), asistente('listo'), usuario('b')];
    expect(forma(msgs)).toEqual(['user:a', 'user:{"success":true,"status":"queued"}', 'assistant:listo', 'user:b']);
    expect(() => validarComoOpenAI(construirVentanaDeMensajes(msgs, 20))).not.toThrow();
  });

  test('resultado huérfano ⇒ se descarta', () => {
    expect(forma([resultado('zz'), usuario('a'), asistente('hola'), resultado('c9')])).toEqual(['user:a', 'assistant:hola']);
  });

  test('varias llamadas en un assistant y solo una con resultado ⇒ queda solo esa', () => {
    const msgs = [usuario('a'), llamada([c1, c2]), resultado('c2'), usuario('b')];
    const ventana = construirVentanaDeMensajes(msgs, 20);
    expect(ventana[1].tool_calls.map((t) => t.id)).toEqual(['c2']);
    expect(() => validarComoOpenAI(ventana)).not.toThrow();
  });

  test('toolCalls vacío ([]) no genera un tool_calls inválido', () => {
    expect(() => validarComoOpenAI(construirVentanaDeMensajes([usuario('a'), llamada([], 'hola'), usuario('b')], 20))).not.toThrow();
  });

  test('el corte de la ventana deja resultados sin su llamada ⇒ se descartan', () => {
    const msgs = [usuario('a'), llamada([c1]), resultado('c1'), asistente('listo'), usuario('b')];
    expect(forma(msgs.slice(0)).length).toBe(5);
    expect(construirVentanaDeMensajes(msgs, 3).map((m) => m.role)).toEqual(['assistant', 'user']);
  });
});

// ── De punta a punta, con Mongo real y el mock estricto ──────────────────────────────────────────────────────────────
const NEGOCIOS = [
  { nombre: 'Negocio ficticio A', phone: '51911111111' },
  { nombre: 'Negocio ficticio B', phone: '+56922222222' },
];

describe.each(NEGOCIOS)('generateReply tras enviar media ($nombre)', ({ nombre, phone }) => {
  let business; let lead; let conversation; let createSpy; let enviado;

  beforeAll(async () => mongoose.connect('mongodb://localhost:27017/creaos_test_toolcalls_huerfanos'));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.restoreAllMocks();
    enviado = [];
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create').mockImplementation(async ({ messages }) => {
      validarComoOpenAI(messages); // lo que haría OpenAI
      enviado.push(messages);
      const siguiente = createSpy.guion.shift();
      if (!siguiente) throw new Error('guion de OpenAI agotado');
      return siguiente;
    });
    createSpy.guion = [];

    business = await Business.create({
      name: nombre,
      presentationVideoAsset: {
        provider: 'cloudinary', publicId: 'negocios/x/video', resourceType: 'video', deliveryType: 'authenticated', status: 'active',
        businessId: new mongoose.Types.ObjectId(), format: 'mp4', mimeType: 'video/mp4', size: 1000, createdAt: new Date(), updatedAt: new Date(),
      },
    });
    business.presentationVideoAsset.businessId = business._id;
    await business.save();
    const channel = await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000009', phoneNumberId: `pnid-huerfanos-${new mongoose.Types.ObjectId()}`, status: 'active',
    });
    lead = await Lead.create({ business: business._id, name: 'Lead', phone });
    conversation = await Conversation.create({
      business: business._id, lead: lead._id, channel: 'whatsapp', whatsappChannel: channel._id, lastInboundMessageAt: new Date(),
    });
  });

  const guion = (...respuestas) => { createSpy.guion.push(...respuestas); };
  const turno = async (texto) => {
    await aiService.saveInboundMessage(conversation._id, texto);
    return aiService.generateReply(conversation._id, await Business.findById(business._id), lead);
  };
  const forma = async () => (await Conversation.findById(conversation._id)).messages.map((m) => {
    if (m.role === 'tool') return `tool:${m.toolCallId}`;
    if (m.toolCalls?.length) return `call:${m.toolCalls.map((t) => t.id)}`;
    return `${m.role}:${m.content}`;
  });

  test('tras enviar el video, el siguiente mensaje del lead SÍ obtiene respuesta (y el historial queda en orden válido)', async () => {
    guion(pideTool(llamadaATool('call_video', 'send_media', { resource: 'presentation_video' })), responde('Te envié el video 🎥'));
    expect((await turno('Mándame el video')).reply).toBe('Te envié el video 🎥');

    // Persistencia: el resultado va JUSTO después de la llamada y conserva rol y tool_call_id; el adjunto, después.
    const mensajes = (await Conversation.findById(conversation._id)).messages;
    const iLlamada = mensajes.findIndex((m) => m.toolCalls?.length);
    expect(mensajes[iLlamada + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_video', name: 'send_media' });
    expect(mensajes[iLlamada + 2]).toMatchObject({ role: 'assistant', mediaType: 'video', mediaKey: 'business:presentation_video' });

    guion(responde('Con gusto, ¿algo más?'));
    expect((await turno('Gracias')).reply).toBe('Con gusto, ¿algo más?'); // antes: 400 y silencio para siempre

    // El historial que viaja al modelo CONSERVA la llamada y su resultado (no se filtran los mensajes internos).
    const alModelo = enviado[enviado.length - 1];
    const iCall = alModelo.findIndex((m) => m.tool_calls);
    expect(alModelo[iCall + 1]).toMatchObject({ role: 'tool', tool_call_id: 'call_video' });

    guion(responde('Claro'));
    expect((await turno('Otra duda')).reply).toBe('Claro'); // y el tercero también
  });

  test('un assistant con varias llamadas, una de ellas con adjunto, queda en orden válido', async () => {
    guion(
      pideTool(llamadaATool('c_buscar', 'search_products', { query: 'granola' }), llamadaATool('c_video', 'send_media', { resource: 'presentation_video' })),
      responde('Listo'),
    );
    await turno('Muéstrame productos y el video');
    expect(await forma()).toEqual(expect.arrayContaining(['call:c_buscar,c_video', 'tool:c_buscar', 'tool:c_video']));
    const f = await forma();
    const i = f.indexOf('call:c_buscar,c_video');
    expect(f.slice(i + 1, i + 3)).toEqual(['tool:c_buscar', 'tool:c_video']);

    guion(responde('Dime'));
    expect((await turno('Hola otra vez')).reply).toBe('Dime');
  });

  test('escalate_to_human (agrega una nota de sistema) tampoco rompe el orden', async () => {
    guion(pideTool(llamadaATool('c_esc', 'escalate_to_human', { reason: 'pide hablar con una persona' })), responde('Te paso con un asesor'));
    await turno('Quiero hablar con alguien');
    const f = await forma();
    const i = f.indexOf('call:c_esc');
    expect(f.slice(i + 1, i + 3)).toEqual(['tool:c_esc', expect.stringMatching(/^system:/)]);

    // El historial se puede reconstruir (una persona reactivará la IA más adelante).
    await Conversation.updateOne({ _id: conversation._id }, { $set: { aiEnabled: true, status: 'active' } });
    guion(responde('Hola de nuevo'));
    expect((await turno('¿Sigues ahí?')).reply).toBe('Hola de nuevo');
  });

  describe('conversaciones ya envenenadas se curan solas (sin migrar datos)', () => {
    const llamada = (id, content = '') => ({ role: 'assistant', content, toolCalls: [llamadaATool(id, 'send_media', { resource: 'presentation_video' })], timestamp: new Date() });
    const resultado = (id) => ({ role: 'tool', content: '{"success":true,"status":"queued"}', toolCallId: id, name: 'send_media', timestamp: new Date() });
    const sembrar = (messages) => Conversation.updateOne({ _id: conversation._id }, { $set: { messages: messages.map((m) => ({ sentBy: 'ai', ...m })) } });

    test('resultado separado de su llamada por el adjunto (como en producción)', async () => {
      await sembrar([
        { role: 'user', content: 'Mándame el video', sentBy: 'lead' },
        llamada('call_viejo'),
        { role: 'assistant', content: '[Video]', mediaUrl: 'https://x.test/v.mp4', mediaType: 'video', mediaKey: 'business:presentation_video' },
        resultado('call_viejo'),
        { role: 'assistant', content: 'Te envié el video' },
      ]);
      guion(responde('Aquí sigo'));
      expect((await turno('Gracias')).reply).toBe('Aquí sigo');
    });

    test('llamada sin resultado', async () => {
      await sembrar([{ role: 'user', content: 'Hola', sentBy: 'lead' }, llamada('call_perdido')]);
      guion(responde('Hola, ¿en qué te ayudo?'));
      expect((await turno('¿Hay alguien?')).reply).toBe('Hola, ¿en qué te ayudo?');
    });

    test('resultado guardado como mensaje del contacto', async () => {
      await sembrar([
        { role: 'user', content: 'Mándame el video', sentBy: 'lead' },
        llamada('call_mal'),
        { role: 'user', content: '{"success":true,"status":"queued"}', sentBy: 'lead' },
      ]);
      guion(responde('Te escucho'));
      expect((await turno('Hola')).reply).toBe('Te escucho');
    });

    test('resultado huérfano', async () => {
      await sembrar([{ role: 'user', content: 'Hola', sentBy: 'lead' }, resultado('call_fantasma'), { role: 'assistant', content: 'Hola' }]);
      guion(responde('Dime'));
      expect((await turno('Buenas')).reply).toBe('Dime');
    });
  });

  test('un resultado de herramienta de más de 4000 caracteres no tumba el guardado del turno', async () => {
    const Product = require('../products/product.model');
    await Promise.all(Array.from({ length: 5 }, (_, i) => Product.create({
      business: business._id, name: `Granola especial ${i}`, sku: `SKU-LARGO-${i}`, price: 10, stock: 5, keywords: ['granola'],
      description: 'Descripción muy larga. '.repeat(40),
    })));
    await Product.syncIndexes();
    // Resultado enorme simulado por la propia tool de búsqueda.
    const productService = require('../products/product.service');
    jest.spyOn(productService, 'buscarProductos').mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({
      productId: String(new mongoose.Types.ObjectId()), name: `Granola ${i}`, description: 'x'.repeat(1200),
    })));
    guion(pideTool(llamadaATool('c_largo', 'search_products', { query: 'granola' })), responde('Tenemos varias granolas'));
    expect((await turno('¿Qué granolas tienen?')).reply).toBe('Tenemos varias granolas');

    const guardado = (await Conversation.findById(conversation._id)).messages.find((m) => m.role === 'tool');
    expect(guardado.content.length).toBeLessThanOrEqual(4000);
    expect(guardado.content).toMatch(/\[recortado\]$/);
    // El modelo SÍ vio el resultado completo durante el turno.
    const vistoEnElTurno = enviado[1].find((m) => m.role === 'tool').content;
    expect(vistoEnElTurno.length).toBeGreaterThan(4000);

    guion(responde('Claro'));
    expect((await turno('Gracias')).reply).toBe('Claro');
  });

  test('cuando generateReply falla, el log NO lleva teléfono ni texto del contacto y el mensaje queda guardado', async () => {
    const errores = jest.spyOn(logger, 'error').mockImplementation(() => {});
    createSpy.mockRestore();
    const spy = jest.spyOn(aiService.openai.chat.completions, 'create').mockRejectedValue(
      Object.assign(new Error(`400 No se pudo procesar el mensaje de ${phone} que dice «mi tarjeta es secreta»`), { status: 400, name: 'BadRequestError' })
    );

    await aiService.saveInboundMessage(conversation._id, 'mi tarjeta es secreta');
    const r = await aiService.runAgent({ conversationId: conversation._id, business: await Business.findById(business._id), lead });

    expect(spy).toHaveBeenCalled();
    expect(r.outcome).toBe('error');
    const registrado = JSON.stringify([errores.mock.calls, r]);
    expect(registrado).not.toContain(phone.replace('+', ''));
    expect(registrado).toMatch(/BadRequestError/);
    expect(errores.mock.calls.some(([, meta]) => meta?.conversationId === String(conversation._id) && meta?.status === 400)).toBe(true);

    const guardada = await Conversation.findById(conversation._id);
    expect(guardada.messages.some((m) => m.role === 'user' && m.content === 'mi tarjeta es secreta')).toBe(true); // no se pierde
  });
});
