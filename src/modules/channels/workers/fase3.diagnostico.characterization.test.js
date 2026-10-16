// FASE 3 / ETAPA A — tests de caracterización del diagnóstico (audit/27). NO cambian comportamiento.
//
// `test.failing(...)` = el cuerpo describe el comportamiento DESEADO y HOY FALLA (por eso Jest lo da por «pasado»
// mientras el defecto exista). Cuando se arregle el defecto el test pasará a fallar y habrá que convertirlo en `test(...)`.
// Los `test(...)` normales fijan hechos del código actual en los que se apoya el diagnóstico.
//
// Todo con Mongo real, el worker de entrada y el de salida REALES, OpenAI simulado (spy) y el proveedor simulado.
// 2 tenants y 2 teléfonos (con y sin "+"): nada es específico de un lead, teléfono o negocio.
jest.mock('../queues/outbound.queue', () => ({ enqueueOutbound: jest.fn(), getOutboundQueue: jest.fn() }));
jest.mock('../../businesses/businessAssetAccess.service');

const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Product = require('../../products/product.model');
const Conversation = require('../../ai/conversation.model');
const InboundEvent = require('../inboundEvent.model');
const OutboundEvent = require('../outboundEvent.model');
const WhatsAppChannel = require('../whatsappChannel.model');
const WhatsAppConsent = require('../../whatsappConsent/whatsappConsent.model');
const aiService = require('../../ai/ai.service');
const aiController = require('../../ai/ai.controller');
const channelService = require('../channel.service');
const subscriptionService = require('../../subscriptions/subscription.service');
const DefaultAgentRuntime = require('../defaultAgentRuntime');
const { enqueueOutbound } = require('../queues/outbound.queue');
const { obtenerUrlDeAcceso } = require('../../businesses/businessAssetAccess.service');
const { descartarClaimsDePrecioStockDesactualizados } = require('../../business-knowledge/priceStockGuard.service');
const { executeToolCall } = require('../../ai/tools');
const { processInboundJob } = require('./inbound.worker');
const { processOutboundJob } = require('./outbound.worker');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_fase3_diagnostico';

const TENANTS = [
  { nombre: 'Negocio ficticio A', from: '51911111111', e164: '+51911111111' },
  { nombre: 'Negocio ficticio B', from: '56922222222', e164: '+56922222222' },
];

const completionTexto = (content) => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const completionTool = (name, args, id = 'call_1') => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe.each(TENANTS)('Fase 3 — diagnóstico ($nombre)', ({ nombre, from, e164 }) => {
  let business;
  let channel;
  let createSpy;
  let pendientes;
  const drenar = async () => {
    while (pendientes.length) {
      // eslint-disable-next-line no-await-in-loop
      await processOutboundJob({ data: { outboundEventId: pendientes.shift() } });
    }
  };
  // Segunda vuelta de OpenAI = el tiempo en el que el worker de salida entrega la media (antes de que el turno se guarde).
  const respuestaFinalMientrasSaleLaMedia = (texto) => async () => { await drenar(); return completionTexto(texto); };

  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({
      planName: 'closer', subscriptionStatus: 'active', limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    });
    jest.spyOn(aiService, 'qualifyLead').mockResolvedValue({});
    jest.spyOn(channelService, 'sendMessage').mockResolvedValue({ messageId: 'wamid-texto' });
    jest.spyOn(channelService, 'sendMedia').mockResolvedValue({ messageId: 'wamid-media' });
    obtenerUrlDeAcceso.mockImplementation(async (biz, campo) => (campo === 'logo' ? 'https://cloudinary.test/logo.png' : null));
    // Cola simulada que reproduce el ORDEN REAL: encolar no ejecuta nada; el worker de salida corre después (`drenar`),
    // mientras el agente todavía espera a OpenAI para su respuesta final y por tanto aún NO ha guardado sus mensajes.
    pendientes = [];
    enqueueOutbound.mockReset().mockImplementation(async (id) => { pendientes.push(id); });

    business = await Business.create({ name: nombre, logo: 'https://cloudinary.test/logo.png' });
    channel = await WhatsAppChannel.create({
      tenantId: business._id, businessId: business._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51900000009', phoneNumberId: `pnid-fase3-${new mongoose.Types.ObjectId()}`, status: 'active',
    });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const entrante = async (text, phone = from) => {
    const ev = await InboundEvent.create({
      providerMessageId: `msg-${new mongoose.Types.ObjectId()}`, provider: 'gupshup', channel: channel._id,
      tenantId: business._id, from: phone, text, status: 'received',
    });
    await processInboundJob({ data: { inboundEventId: ev._id } });
    await drenar(); // el envío del texto final de la IA
    return ev;
  };
  const conversacion = () => Conversation.findOne({ business: business._id });

  describe('B) Envío de archivos', () => {
    test.failing('el mensaje con la imagen refleja el estado REAL del envío (hoy se queda en «queued» ⇒ reloj de arena)', async () => {
      createSpy.mockResolvedValueOnce(completionTool('send_media', { resource: 'logo' }))
        .mockImplementationOnce(respuestaFinalMientrasSaleLaMedia('Aquí tienes el logo.'));
      await entrante('¿Tienes el logo?');

      const evento = await OutboundEvent.findOne({ tenantId: business._id, messageType: 'media' });
      expect(evento.status).toBe('sent'); // el envío SÍ salió (el proveedor simulado lo aceptó)
      const conv = await conversacion();
      const mensajeMedia = conv.messages.find((m) => m.mediaKey === 'business:logo');
      expect(mensajeMedia.whatsappStatus).toBe(evento.status); // hoy: 'queued'
    });

    test('CARACTERIZACIÓN: el worker sincroniza el mensaje por `messages.outboundEventId`, pero el mensaje se guarda DESPUÉS (al final del turno)', async () => {
      createSpy.mockResolvedValueOnce(completionTool('send_media', { resource: 'logo' }))
        .mockImplementationOnce(respuestaFinalMientrasSaleLaMedia('Aquí tienes el logo.'));
      await entrante('¿Tienes el logo?');
      const conv = await conversacion();
      const m = conv.messages.find((x) => x.mediaKey === 'business:logo');
      expect((await OutboundEvent.findOne({ messageType: 'media' })).status).toBe('sent'); // el envío SÍ salió
      expect(m.whatsappStatus).toBe('queued'); // el valor que tenía al construirse, nunca actualizado
      expect(String(m.outboundEventId)).toBe(String((await OutboundEvent.findOne({ messageType: 'media' }))._id));
    });

    test('CARACTERIZACIÓN: un turno con tool deja en la conversación un mensaje del asistente SIN texto y un mensaje role:tool con JSON', async () => {
      createSpy.mockResolvedValueOnce(completionTool('send_media', { resource: 'logo' }))
        .mockResolvedValueOnce(completionTexto('Aquí tienes el logo.'));
      await entrante('¿Tienes el logo?');
      const conv = await conversacion();
      const vacio = conv.messages.filter((m) => m.role === 'assistant' && !m.content && !m.mediaUrl);
      const herramienta = conv.messages.filter((m) => m.role === 'tool');
      expect(vacio).toHaveLength(1); // la burbuja vacía del chat
      expect(vacio[0].toolCalls).toHaveLength(1);
      expect(herramienta).toHaveLength(1);
      expect(() => JSON.parse(herramienta[0].content)).not.toThrow();
      expect(vacio[0].sentBy).toBe('ai'); // el default del esquema: la UI lo pinta como mensaje de la IA
    });

    test.failing('la API de la conversación NO entrega al chat los mensajes internos de herramientas (hoy sí: burbuja vacía + JSON)', async () => {
      createSpy.mockResolvedValueOnce(completionTool('send_media', { resource: 'logo' }))
        .mockResolvedValueOnce(completionTexto('Aquí tienes el logo.'));
      await entrante('¿Tienes el logo?');
      const conv = await conversacion();
      const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
      await aiController.getConversation({ params: { conversationId: String(conv._id) }, businessId: business._id }, res, jest.fn());
      const cuerpo = JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
      const mensajes = cuerpo.data.conversation.messages;
      expect(mensajes.filter((m) => m.role === 'tool')).toHaveLength(0);
      expect(mensajes.filter((m) => m.role === 'assistant' && !m.content && !m.mediaUrl)).toHaveLength(0);
    });

    test.failing('si el contacto pide la baja MIENTRAS el agente trabaja, la tool no encola el archivo (la política va ANTES de «queued»)', async () => {
      createSpy.mockImplementationOnce(async () => {
        // Llega la BAJA mientras OpenAI está respondiendo este turno.
        await WhatsAppConsent.create({ tenantId: business._id, phone: e164, status: 'OPTED_OUT', purpose: 'conversational', source: 'user_message', revokedAt: new Date() });
        return completionTool('send_media', { resource: 'logo' });
      }).mockImplementationOnce(respuestaFinalMientrasSaleLaMedia('Aquí tienes el logo.'));
      await entrante('¿Tienes el logo?');

      expect(await OutboundEvent.countDocuments({ tenantId: business._id, messageType: 'media' })).toBe(0); // hoy: 1 evento que el worker omite
      const conv = await conversacion();
      expect(conv.messages.some((m) => m.mediaKey === 'business:logo')).toBe(false); // hoy: mensaje «queued» para siempre
    });

    test('CARACTERIZACIÓN: con la baja ya registrada ANTES del mensaje, el agente NO corre (el worker de entrada corta) y no se genera nada', async () => {
      await WhatsAppConsent.create({ tenantId: business._id, phone: e164, status: 'OPTED_OUT', purpose: 'conversational', source: 'user_message', revokedAt: new Date(Date.now() - 3600 * 1000) });
      await entrante('¿Tienes el logo?');
      expect(createSpy).not.toHaveBeenCalled();
      expect(await OutboundEvent.countDocuments({ tenantId: business._id })).toBe(0);
      const conv = await conversacion();
      expect(conv.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    });

    test('CARACTERIZACIÓN: el PDF informativo NO es enviable (send_media solo conoce logo, presentation_video y brochure)', async () => {
      const lead = await Lead.create({ business: business._id, name: 'Lead', phone: e164 });
      const conv = await Conversation.create({ business: business._id, lead: lead._id, channel: 'whatsapp', whatsappChannel: channel._id, lastInboundMessageAt: new Date() });
      const r = await executeToolCall(
        { id: 'c1', function: { name: 'send_media', arguments: JSON.stringify({ resource: 'pdf' }) } },
        { conversation: conv, business, lead }
      );
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Recurso desconocido.*logo, presentation_video, brochure/);
    });

    test('CARACTERIZACIÓN: sin foto cargada en el producto, send_product_photos responde asset_missing; las fotos del negocio (Business.photos) no cuentan', async () => {
      const lead = await Lead.create({ business: business._id, name: 'Lead', phone: e164 });
      const producto = await Product.create({ business: business._id, name: 'Producto de prueba', sku: 'SKU-PRUEBA-1', price: 10, stock: 5 });
      const conv = await Conversation.create({ business: business._id, lead: lead._id, channel: 'whatsapp', whatsappChannel: channel._id, lastInboundMessageAt: new Date() });
      await Business.updateOne({ _id: business._id }, { $set: { photos: ['https://cloudinary.test/foto-negocio.jpg'] } });
      const r = await executeToolCall(
        { id: 'c2', function: { name: 'send_product_photos', arguments: JSON.stringify({ productId: String(producto._id) }) } },
        { conversation: conv, business: await Business.findById(business._id), lead }
      );
      expect(r).toMatchObject({ success: false, status: 'asset_missing' });
    });
  });

  describe('B/D) Estado de los mensajes de texto de la IA', () => {
    test.failing('el mensaje de texto de la IA queda ligado a su OutboundEvent y refleja su estado (hoy «not_applicable» ⇒ la UI pinta ⏳ siempre)', async () => {
      createSpy.mockResolvedValueOnce(completionTexto('Hola, ¿en qué te ayudo?'));
      await entrante('Hola');
      const evento = await OutboundEvent.findOne({ tenantId: business._id, messageType: 'text' });
      expect(evento.status).toBe('sent');
      const conv = await conversacion();
      const respuesta = conv.messages.find((m) => m.role === 'assistant' && m.content === 'Hola, ¿en qué te ayudo?');
      expect(respuesta.whatsappStatus).toBe('sent'); // hoy: 'not_applicable'
      expect(String(respuesta.outboundEventId)).toBe(String(evento._id)); // hoy: null
    });
  });

  describe('C) Formato para WhatsApp', () => {
    test.failing('los enlaces Markdown y las negritas ** no llegan crudos a WhatsApp ni al historial', async () => {
      createSpy.mockResolvedValueOnce(completionTexto('Mira [nuestra web](https://creaosapp.com) y la **oferta** de hoy.'));
      await entrante('¿Dónde veo más?');
      const evento = await OutboundEvent.findOne({ tenantId: business._id, messageType: 'text' });
      expect(evento.text).not.toMatch(/\]\(|\*\*/); // hoy: se envía tal cual
      expect(evento.text).toContain('https://creaosapp.com');
      const conv = await conversacion();
      expect(conv.messages.find((m) => m.role === 'assistant').content).not.toMatch(/\]\(|\*\*/);
    });

    test('CARACTERIZACIÓN: hoy el texto de la IA sale tal cual lo escribió el modelo (sin ninguna conversión)', async () => {
      createSpy.mockResolvedValueOnce(completionTexto('Mira [nuestra web](https://creaosapp.com)'));
      await entrante('¿Dónde veo más?');
      expect(channelService.sendMessage).toHaveBeenCalledTimes(1);
      expect(channelService.sendMessage.mock.calls[0][2]).toBe('Mira [nuestra web](https://creaosapp.com)');
    });
  });

  describe('D) El agente tras una baja', () => {
    const darDeBaja = () => WhatsAppConsent.create({
      tenantId: business._id, phone: e164, status: 'OPTED_OUT', purpose: 'conversational', source: 'user_message', revokedAt: new Date(Date.now() - 3600 * 1000),
    });

    test.failing('aiService.chat (POST /ai/conversations/:id/message) no genera ni guarda respuesta para un contacto en baja', async () => {
      const lead = await Lead.create({ business: business._id, name: 'Lead', phone: e164 });
      const conv = await Conversation.create({ business: business._id, lead: lead._id, channel: 'whatsapp', whatsappChannel: channel._id, aiEnabled: true });
      await darDeBaja();
      createSpy.mockResolvedValue(completionTexto('Respuesta que no debería existir'));
      await aiService.chat(conv._id, 'Hola', business, lead);
      expect(createSpy).not.toHaveBeenCalled(); // hoy: se llama a OpenAI y se guarda la respuesta
      expect((await Conversation.findById(conv._id)).messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    });

    test.failing('el runtime del agente (DefaultAgentRuntime.process) no llama a OpenAI para un contacto en baja', async () => {
      const lead = await Lead.create({ business: business._id, name: 'Lead', phone: e164 });
      const conv = await Conversation.create({
        business: business._id, lead: lead._id, channel: 'whatsapp', whatsappChannel: channel._id, aiEnabled: true,
        messages: [{ role: 'user', content: 'Hola', sentBy: 'lead' }],
      });
      await darDeBaja();
      createSpy.mockResolvedValue(completionTexto('Respuesta que no debería existir'));
      const salida = await new DefaultAgentRuntime().process({
        tenantId: String(business._id), channelId: String(channel._id), conversationId: String(conv._id), leadId: String(lead._id),
        message: { text: 'Hola' }, businessContext: business, conversationHistory: [],
      });
      expect(createSpy).not.toHaveBeenCalled(); // hoy: genera y GUARDA la respuesta
      expect(salida.reply).toBeNull();
    });
  });

  describe('A) Conocimiento (PDF)', () => {
    test('CARACTERIZACIÓN: la barrera descarta un fragmento del PDF que menciona «disponible»/precio si el catálogo tiene un producto parecido', async () => {
      await Product.syncIndexes(); // el índice de texto de `buscarProductos` debe existir en la base de prueba
      await Product.create({ business: business._id, name: 'Proteína vegetal', sku: 'SKU-PRUEBA-2', description: 'Proteína vegetal en polvo', price: 80, stock: 3, active: true });
      const chunks = [
        { text: 'Proteína vegetal en polvo, disponible en sabores vainilla y chocolate.', page: 1, score: 0.9 },
        { text: 'Somos una marca peruana de nutrición natural.', page: 1, score: 0.8 },
      ];
      const pasan = await descartarClaimsDePrecioStockDesactualizados(chunks, business._id);
      expect(pasan.map((c) => c.text)).toEqual(['Somos una marca peruana de nutrición natural.']);
    });

    test('CARACTERIZACIÓN: con el catálogo vacío la barrera no descarta nada (el PDF sí llega al modelo)', async () => {
      const chunks = [{ text: 'Proteína vegetal en polvo, disponible en sabores vainilla y chocolate.', page: 1, score: 0.9 }];
      expect(await descartarClaimsDePrecioStockDesactualizados(chunks, business._id)).toHaveLength(1);
    });

    test('CARACTERIZACIÓN: el prompt siempre inyecta el resumen del PDF (≤800) y manda usar los fragmentos solo para información general, nunca precio/stock', async () => {
      await Business.updateOne({ _id: business._id }, { $set: { pdfSummary: 'Resumen del PDF del negocio.' } });
      createSpy.mockResolvedValueOnce(completionTexto('ok'));
      const lead = await Lead.create({ business: business._id, name: 'Lead', phone: e164 });
      const conv = await Conversation.create({ business: business._id, lead: lead._id, channel: 'whatsapp', messages: [{ role: 'user', content: '¿Qué productos tienen?', sentBy: 'lead' }] });
      await aiService.generateReply(conv._id, await Business.findById(business._id), lead);
      const prompt = createSpy.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain('Información adicional del negocio (de su documento):\nResumen del PDF del negocio.');
      expect(prompt).toMatch(/documentChunks son fragmentos del PDF del negocio — úsalos SOLO para información general/);
      expect(prompt).toMatch(/NUNCA para precio o stock/);
      expect(prompt).not.toMatch(/markdown|negrita|enlaces? en formato/i); // C: ninguna instrucción de formato para WhatsApp
    });
  });
});
