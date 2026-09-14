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

jest.mock('../../channels/channel.service');
const channelService = require('../../channels/channel.service');

const { executeToolCall } = require('./index');

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
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Conversation.deleteMany({});
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

    channelService.getChannelForConversation.mockResolvedValue({ _id: 'channel-real-id' });
    channelService.sendMedia.mockResolvedValue({ messages: [{ id: 'msg-real-1' }] });
  });

  test('resource:"logo" — resuelve business.logo, arma type:"image", llama a channelService.sendMedia() con la URL real', async () => {
    const result = await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(channelService.sendMedia).toHaveBeenCalledWith('channel-real-id', '+51987654321', {
      url: 'https://cloudinary.test/logo.png',
      type: 'image',
    }, business._id);
    expect(result).toEqual({ success: true, message: 'Se envió logo al lead por WhatsApp.' });
  });

  test('resource:"presentation_video" — resuelve business.presentationVideoUrl, arma type:"video"', async () => {
    await executeToolCall(toolCall({ resource: 'presentation_video' }), { conversation, business, lead });

    expect(channelService.sendMedia).toHaveBeenCalledWith('channel-real-id', '+51987654321', {
      url: 'https://cloudinary.test/presentacion.mp4',
      type: 'video',
    }, business._id);
  });

  test('resource:"brochure" — resuelve business.brochureUrl + brochureFilename, arma type:"document" con filename (confirmado en el Paso 1 que Gupshup lo acepta ahí)', async () => {
    await executeToolCall(toolCall({ resource: 'brochure' }), { conversation, business, lead });

    expect(channelService.sendMedia).toHaveBeenCalledWith('channel-real-id', '+51987654321', {
      url: 'https://cloudinary.test/brochure.pdf',
      type: 'document',
      filename: 'brochure-creaos.pdf',
    }, business._id);
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

  test('registra el envío como mensaje assistant propio (sentBy:"ai", mediaUrl/mediaType) — visible en el historial de chat, no solo como JSON de bookkeeping', async () => {
    await executeToolCall(toolCall({ resource: 'brochure' }), { conversation, business, lead });

    const mensajeMedia = conversation.messages.find((m) => m.mediaUrl === 'https://cloudinary.test/brochure.pdf');
    expect(mensajeMedia).toMatchObject({
      role: 'assistant',
      sentBy: 'ai',
      mediaType: 'document',
      whatsappStatus: 'sent',
    });
  });

  test('channelService.sendMedia() falla (ej. Gupshup responde error): executeToolCall() lo atrapa, nunca propaga', async () => {
    channelService.sendMedia.mockRejectedValue(new Error('Gupshup Partner API error (media send): 400'));

    const result = await executeToolCall(toolCall({ resource: 'logo' }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Error ejecutando send_media/);
  });
});
