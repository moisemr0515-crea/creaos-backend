// Test real (Jest, Mongo real) de la tool send_product_photos — Bloque 2
// de la auditoría Business Brain (§37-44, 20/sep/2026). Mismo criterio que
// index.sendMedia.test.js: channelService se mockea entero (nunca pega
// contra Gupshup real), productAssetAccess.service se mockea (su propia
// resolución ya tiene test dedicado en productAssetAccess.service.test.js)
// — el foco acá es el contrato de la tool: resolución de producto
// (resolverProductId, tenant-safe), guards de WhatsApp compartidos con
// send_media, anti-spam determinístico (mediaKey), y fallback cuando el
// producto no tiene fotos.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Product = require('../../products/product.model');
const Lead = require('../../leads/lead.model');
const Conversation = require('../conversation.model');

jest.mock('../../channels/channel.service');
const channelService = require('../../channels/channel.service');

jest.mock('../../products/productAssetAccess.service');
const productAssetAccess = require('../../products/productAssetAccess.service');

const { executeToolCall } = require('./index');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_sendproductphotos';

const toolCall = (args) => ({
  id: 'call_test_1',
  function: { name: 'send_product_photos', arguments: JSON.stringify(args) },
});

describe('ai/tools/index — send_product_photos', () => {
  let business;
  let producto;
  let lead;
  let conversation;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Conversation.deleteMany({});
    await Lead.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});

    business = await Business.create({ name: 'CREA OS' });
    producto = await Product.create({
      business: business._id,
      sku: 'MOR-001',
      name: 'Moringa 100 cápsulas',
      mediaAssets: [{ publicId: 'creaos/products/x/y/a', resourceType: 'image', isPrimary: true, caption: 'Vista frontal' }],
    });
    lead = await Lead.create({ business: business._id, name: 'Lead de prueba', phone: '+51987654321' });
    conversation = new Conversation({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      whatsappChannel: new mongoose.Types.ObjectId(),
      lastInboundMessageAt: new Date(),
      activeProduct: { productId: producto._id, name: producto.name, lastSearchQuery: 'moringa', updatedAt: new Date() },
    });

    channelService.getChannelForConversation.mockResolvedValue({ _id: 'channel-real-id' });
    channelService.sendMedia.mockResolvedValue({ messages: [{ id: 'msg-real-1' }] });

    productAssetAccess.resolverFotoPrincipal.mockImplementation((p) =>
      p.mediaAssets.length ? { publicId: p.mediaAssets[0].publicId, resourceType: p.mediaAssets[0].resourceType, caption: p.mediaAssets[0].caption } : null
    );
    productAssetAccess.obtenerUrlDeAccesoFotoPrincipal.mockReturnValue('https://api.cloudinary.com/firmada-producto');
  });

  test('con productId explícito: resuelve la foto principal, arma type:"image" con caption, llama a channelService.sendMedia()', async () => {
    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(channelService.sendMedia).toHaveBeenCalledWith('channel-real-id', '+51987654321', {
      url: 'https://api.cloudinary.com/firmada-producto',
      type: 'image',
      caption: 'Vista frontal',
    }, business._id);
    expect(result).toEqual({ success: true, message: `Se envió una foto de "${producto.name}" al lead por WhatsApp.` });
  });

  test('sin productId: cae a conversation.activeProduct (mismo mecanismo que check_stock/get_price)', async () => {
    await executeToolCall(toolCall({}), { conversation, business, lead });

    expect(channelService.sendMedia).toHaveBeenCalled();
  });

  test('pide el acceso con propósito "send" (TTL largo) — misma restricción real que send_media', async () => {
    await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(productAssetAccess.obtenerUrlDeAccesoFotoPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ _id: producto._id }),
      'send'
    );
  });

  test('sin productId ni activeProduct: error claro, pide usar search_products primero', async () => {
    conversation.activeProduct = undefined;

    const result = await executeToolCall(toolCall({}), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Usa search_products primero/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('productId de OTRO negocio: 404 vía executeToolCall (nunca resuelve ni manda nada de otro tenant)', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    const otroProducto = await Product.create({ business: otroBusiness._id, sku: 'X-1', name: 'Producto de otro negocio' });

    const result = await executeToolCall(toolCall({ productId: otroProducto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Producto no encontrado/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('producto desactivado: no lo encuentra (mismo criterio que check_stock/get_price)', async () => {
    await Product.findByIdAndUpdate(producto._id, { active: false });

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Producto no encontrado/);
  });

  test('producto sin ninguna foto cargada: fallback claro, nunca inventa ni usa otra foto', async () => {
    const sinFotos = await Product.create({ business: business._id, sku: 'SIN-FOTO', name: 'Producto sin fotos' });
    productAssetAccess.resolverFotoPrincipal.mockReturnValue(null);

    const result = await executeToolCall(toolCall({ productId: sinFotos._id.toString() }), { conversation, business, lead });

    expect(result).toEqual({ success: false, error: 'El producto "Producto sin fotos" todavía no tiene ninguna foto cargada.' });
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('anti-spam: ya se envió una foto de este producto en los últimos mensajes — rechaza sin reenviar', async () => {
    conversation.messages.push({ role: 'assistant', content: '[Imagen]', mediaKey: `product:${producto._id}` });

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Ya se envió una foto/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('anti-spam: NO bloquea el envío de una foto de OTRO producto (mediaKey distinto)', async () => {
    conversation.messages.push({ role: 'assistant', content: '[Imagen]', mediaKey: 'product:otro-producto-cualquiera' });

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(true);
    expect(channelService.sendMedia).toHaveBeenCalled();
  });

  test('registra el envío con mediaKey estable (no la URL firmada) — para que el guard anti-spam funcione en el próximo turno', async () => {
    await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    const mensaje = conversation.messages.find((m) => m.mediaType === 'image');
    expect(mensaje.mediaKey).toBe(`product:${producto._id}`);
  });

  test('conversación que no es de WhatsApp: rechaza antes de resolver ninguna foto', async () => {
    conversation.channel = 'manual';

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/solo está disponible en conversaciones por WhatsApp/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('lead sin teléfono: rechaza antes de tocar channelService', async () => {
    const leadSinTelefono = await Lead.create({ business: business._id, name: 'Sin teléfono' });

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), {
      conversation,
      business,
      lead: leadSinTelefono,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no tiene un número de teléfono registrado/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('ventana de 24h cerrada: rechaza, mismo criterio que send_media', async () => {
    conversation.lastInboundMessageAt = new Date(Date.now() - 25 * 60 * 60 * 1000);

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ventana de 24h de WhatsApp está cerrada/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('sin canal de WhatsApp activo resuelto: rechaza en vez de tirar una excepción sin contexto', async () => {
    channelService.getChannelForConversation.mockResolvedValue(null);

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No hay un canal de WhatsApp activo/);
    expect(channelService.sendMedia).not.toHaveBeenCalled();
  });

  test('channelService.sendMedia() falla: executeToolCall() lo atrapa, nunca propaga', async () => {
    channelService.sendMedia.mockRejectedValue(new Error('Gupshup Partner API error (media send): 400'));

    const result = await executeToolCall(toolCall({ productId: producto._id.toString() }), { conversation, business, lead });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Error ejecutando send_product_photos/);
  });
});
