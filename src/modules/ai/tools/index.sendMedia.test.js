// Test real (Jest, Mongo real) de la tool send_media (auditoría de
// factibilidad, 12/sep/2026, Paso 3/3) — vía executeToolCall(), el mismo
// punto de entrada real que usa generateReply(). channelService se
// mockea entero (nunca pega contra Gupshup real, ni siquiera el cliente
// Partner) — el foco acá es que la tool resuelve la URL REAL desde
// Business según el enum cerrado, arma el `type` correcto, y respeta los
// mismos guards que ya usa el envío manual de un agente humano
// (ai.service.js#sendMediaMessage()): canal WhatsApp, teléfono del lead,
// ventana de 24h abierta.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Conversation = require('../conversation.model');
const OutboundEvent = require('../../channels/outboundEvent.model');

jest.mock('../../channels/channel.service');
const channelService = require('../../channels/channel.service');
jest.mock('../../channels/queues/outbound.queue', () => ({ enqueueOutbound: jest.fn() }));
const { enqueueOutbound } = require('../../channels/queues/outbound.queue');

// P0 de seguridad (auditoría Business Brain, 19/sep/2026, Bloque 1) —
// sendMedia() ya no lee business.logo/presentationVideoUrl/brochureUrl
// directo, pide un acceso firmado vía businessAssetAccess.service.js. Se
// mockea acá porque su propia resolución (publicId/resourceType/TTL) ya
// tiene su test dedicado (businessAssetAccess.service.test.js) — este
// archivo se queda enfocado en su propio contrato: guards de WhatsApp,
// armado del payload, manejo de errores.
jest.mock('../../businesses/businessAssetAccess.service');
const { obtenerUrlDeAcceso } = require('../../businesses/businessAssetAccess.service');

const { executeToolCall } = require('./index');
const aiService = require('../ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_sendmedia';

const toolCall = (args) => ({
  id: 'call_test_1',
  function: { name: 'send_media', arguments: JSON.stringify(args) },
});

describe('ai/tools/index — send_media', () => {
  let business;
  let lead;
  let conversation;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await OutboundEvent.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Conversation.deleteMany({});
    await OutboundEvent.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});

    business = await Business.create({
      name: 'CREA OS',
      logo: 'https://cloudinary.test/logo.png',
      presentationVideoUrl: 'https://cloudinary.test/presentacion.mp4',
      brochureUrl: 'https://cloudinary.test/brochure.pdf',
      brochureFilename: 'brochure-creaos.pdf',
    });
    lead = await Lead.create({ business: business._id, name: 'Lead de prueba', phone: '+51987654321' });
    conversation = new Conversation({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      whatsappChannel: new mongoose.Types.ObjectId(),
      lastInboundMessageAt: new Date(), // ventana de 24h abierta
    });

    channelService.getChannelForConversation.mockResolvedValue({ _id: conversation.whatsappChannel, provider: 'gupshup' });
    enqueueOutbound.mockImplementation(async (eventId) => {
      await OutboundEvent.updateOne({ _id: eventId }, { status: 'queued' });
    });

    // Mismo mapeo campo->URL que tenían los fixtures ANTES de este cambio
    // (business.logo/presentationVideoUrl/brochureUrl) — el objetivo de
    // este archivo es probar sendMedia(), no la resolución de
    // businessAssetAccess.service.js (ver su propio test).
    obtenerUrlDeAcceso.mockImplementation((biz, campo) => {
      if (campo === 'logo') return biz.logo || null;
      if (campo === 'presentationVideo') return biz.presentationVideoUrl || null;
      if (campo === 'brochure') return biz.brochureUrl || null;
      return null;
    });
  });

  test('resource:"logo" — crea OutboundEvent image y nunca llama al proveedor desde la tool', async () => {
    const result = await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event).toMatchObject({ origin: 'ai', messageType: 'media', status: 'queued', to: '+51987654321' });
    expect(event.payload.media).toEqual({ url: 'https://cloudinary.test/logo.png', type: 'image' });
    expect(enqueueOutbound).toHaveBeenCalledWith(event._id);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, status: 'queued', deliveryStatus: 'queued' });
  });

  test('pide el acceso con propósito "send" (TTL largo) — restricción real: Meta/Gupshup buscan el archivo de forma asíncrona, no al instante', async () => {
    await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(obtenerUrlDeAcceso).toHaveBeenCalledWith(expect.objectContaining({ _id: business._id }), 'logo', 'send');
  });

  test('resource:"presentation_video" — resuelve business.presentationVideoUrl, arma type:"video"', async () => {
    await executeToolCall(toolCall({ resource: 'presentation_video' }), { conversation, business, lead });

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event.payload.media).toEqual({ url: 'https://cloudinary.test/presentacion.mp4', type: 'video' });
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('resource:"brochure" — resuelve business.brochureUrl + brochureFilename, arma type:"document" con filename (confirmado en el Paso 1 que Gupshup lo acepta ahí)', async () => {
    await executeToolCall(toolCall({ resource: 'brochure' }), { conversation, business, lead });

    const event = await OutboundEvent.findOne({ conversation: conversation._id });
    expect(event.payload.media).toEqual({
      url: 'https://cloudinary.test/brochure.pdf', type: 'document', filename: 'brochure-creaos.pdf',
    });
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('el modelo NUNCA puede mandar una URL libre — un "resource" fuera del enum se rechaza sin llamar a channelService', async () => {
    const result = await executeToolCall(
      toolCall({ resource: 'https://sitio-cualquiera.com/x.pdf' }),
      { conversation, business, lead },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Recurso desconocido/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('negocio sin ese archivo cargado (ej. brochure nunca subido): error claro, nunca intenta enviar', async () => {
    await Business.findByIdAndUpdate(business._id, { brochureUrl: null, brochureFilename: null });
    const negocioSinBrochure = await Business.findById(business._id);

    const result = await executeToolCall(toolCall({ resource: 'brochure' }), {
      conversation,
      business: negocioSinBrochure,
      lead,
    });

    expect(result).toEqual({
      success: false,
      status: 'asset_missing',
      error: 'Este negocio todavía no cargó su brochure — no hay nada que enviar.',
    });
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('conversación que no es de WhatsApp: rechaza antes de tocar channelService', async () => {
    conversation.channel = 'manual';

    const result = await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/solo está disponible en conversaciones por WhatsApp/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('lead sin teléfono: rechaza antes de tocar channelService', async () => {
    const leadSinTelefono = await Lead.create({ business: business._id, name: 'Sin teléfono' });
    conversation.lead = leadSinTelefono._id;

    const result = await executeToolCall(toolCall({ resource: 'logo' }), {
      conversation,
      business,
      lead: leadSinTelefono,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no tiene un número de teléfono registrado/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('ventana de 24h cerrada (sin lastInboundMessageAt reciente): rechaza, mismo criterio que el envío manual de un agente humano', async () => {
    conversation.lastInboundMessageAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // hace 25h

    const result = await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ventana de 24h de WhatsApp está cerrada/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('sin canal de WhatsApp activo resuelto: rechaza en vez de tirar una excepción sin contexto', async () => {
    channelService.getChannelForConversation.mockResolvedValue(null);

    const result = await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No hay un canal de WhatsApp activo/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('contexto cross-tenant se bloquea antes de crear OutboundEvent', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    const leadDeOtroTenant = await Lead.create({ business: otroBusiness._id, name: 'Lead externo', phone: '+51911111111' });

    const result = await executeToolCall(toolCall({ resource: 'logo' }), {
      conversation,
      business,
      lead: leadDeOtroTenant,
    });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/contexto de conversación, lead y negocio es inconsistente/);
    expect(await OutboundEvent.countDocuments({})).toBe(0);
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });

  test('registra el envío como mensaje assistant propio (sentBy:"ai", mediaUrl/mediaType) — visible en el historial de chat, no solo como JSON de bookkeeping', async () => {
    await executeToolCall(toolCall({ resource: 'brochure' }), { conversation, business, lead });

    const mensajeMedia = conversation.messages.find((m) => m.mediaUrl === 'https://cloudinary.test/brochure.pdf');
    expect(mensajeMedia).toMatchObject({
      role: 'assistant',
      sentBy: 'ai',
      mediaType: 'document',
      whatsappStatus: 'queued',
      outboundEventId: expect.any(mongoose.Types.ObjectId),
    });
  });

  test('un replay del mismo tool_call es idempotente: reutiliza evento y no duplica intención', async () => {
    await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });
    conversation.messages = [];
    await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(await OutboundEvent.countDocuments({ conversation: conversation._id })).toBe(1);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('generateReply continúa después del resultado queued de la tool y produce respuesta final', async () => {
    const persistedConversation = await Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      lastInboundMessageAt: new Date(),
      messages: [{ role: 'user', content: 'Envíame el video de presentación', sentBy: 'lead' }],
    });
    const resolvedChannelId = new mongoose.Types.ObjectId();
    channelService.getChannelForConversation.mockResolvedValue({ _id: resolvedChannelId, provider: 'gupshup' });
    const openai = jest.spyOn(aiService.openai.chat.completions, 'create')
      .mockResolvedValueOnce({
        choices: [{ message: {
          content: null,
          tool_calls: [toolCall({ resource: 'presentation_video' })],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'Te envié el video de presentación.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });

    const result = await aiService.generateReply(persistedConversation._id, business, lead);

    expect(result.reply).toBe('Te envié el video de presentación.');
    const event = await OutboundEvent.findOne({ conversation: persistedConversation._id });
    expect(event).toMatchObject({ messageType: 'media', origin: 'ai', status: 'queued' });
    const storedConversation = await Conversation.findById(persistedConversation._id);
    expect(storedConversation.messages.some((message) => message.role === 'tool'
      && message.content.includes('"status":"queued"'))).toBe(true);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
    openai.mockRestore();
  });
});
