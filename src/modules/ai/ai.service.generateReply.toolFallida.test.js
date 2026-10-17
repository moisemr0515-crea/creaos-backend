// Tras un fallo de herramienta la IA no inventa precio, stock ni etapa. Decisión de producto: si get_price/check_stock fallan
// TÉCNICAMENTE sobre un producto que SÍ está en el catálogo, no se usa el PDF para el precio; la IA dice que lo confirmará.
// Para productos fuera del catálogo el documento sigue valiendo. Aquí se prueba lo que ve el modelo (el resultado de la tool
// y el prompt), no lo que decide decir: eso es de OpenAI. Mongo real; OpenAI simulado.
const mongoose = require('mongoose');
const logger = require('../../utils/logger');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Product = require('../products/product.model');
const productService = require('../products/product.service');
const Conversation = require('./conversation.model');
const aiService = require('./ai.service');
const { TOOL_REGISTRY, executeToolCall } = require('./tools');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_tool_fallida';
const SLUG = 'aceite_de_moringa_qhali_kausay';

const toolCallMock = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const conToolCalls = (toolCalls) => ({ choices: [{ message: { content: '', tool_calls: toolCalls } }], usage: { total_tokens: 15 } });
const final = (content) => ({ choices: [{ message: { content, tool_calls: undefined } }], usage: { total_tokens: 15 } });

describe('tras un fallo de herramienta la IA no inventa', () => {
  let business;
  let lead;
  let conversation;
  let producto;
  let createSpy;
  let errorSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Product.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Product.deleteMany({}), Business.deleteMany({})]);
    // El negocio tiene un PDF que menciona un precio DISTINTO al del catálogo: es la tentación que hay que cerrar.
    business = await Business.create({ name: 'Nutriva de prueba', currency: 'PEN', pdfSummary: 'Aceite de Moringa Qhali Kausay: S/ 999 (precio de lista del PDF).' });
    producto = await Product.create({
      business: business._id, sku: 'ACE-MOR', name: 'Aceite de Moringa Qhali Kausay', keywords: ['aceite', 'moringa'], price: 80, currency: 'PEN', physicalStock: 12,
    });
    lead = await Lead.create({ business: business._id, name: 'Ana' });
    conversation = await Conversation.create({
      business: business._id, lead: lead._id, channel: 'whatsapp', messages: [{ role: 'user', content: '¿Cuánto cuesta el aceite de moringa?' }],
    });
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
  });

  const correrTurno = () => aiService.generateReply(conversation._id, business, lead);
  const mensajeTool = (llamada, toolCallId) => JSON.parse(
    createSpy.mock.calls[llamada][0].messages.find((m) => m.role === 'tool' && m.tool_call_id === toolCallId).content
  );

  describe('lo que recibe el modelo cuando una herramienta falla', () => {
    test('una tool que LANZA devuelve success:false, el error y el aviso de no inventar', async () => {
      const result = await executeToolCall(
        toolCallMock('c1', 'get_price', { productId: new mongoose.Types.ObjectId().toString() }), // id con forma válida pero inexistente
        { conversation, business, lead }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Producto no encontrado/);
      expect(result.aviso).toMatch(/no inventes ni afirmes como confirmado/);
    });

    test('un productId inventado devuelve el aviso además de la guía para corregirlo', async () => {
      const result = await executeToolCall(toolCallMock('c1', 'get_price', { productId: SLUG }), { conversation, business, lead });
      expect(result.error).toMatch(/search_products/);
      expect(result.aviso).toMatch(/no inventes/);
    });

    test.each(TOOL_REGISTRY.map((t) => [t.name]))('contrato: si %s lanza, el resultado lleva el aviso (ninguna tool queda sin él)', async (nombre) => {
      const tool = TOOL_REGISTRY.find((t) => t.name === nombre);
      jest.spyOn(tool, 'execute').mockRejectedValue(new Error('fallo técnico simulado'));

      const result = await executeToolCall(toolCallMock('c1', nombre, {}), { conversation, business, lead });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('fallo técnico simulado'), aviso: expect.stringMatching(/no inventes/) });
    });
  });

  describe('el prompt cierra la puerta del PDF para el precio y el stock de un producto del catálogo', () => {
    const prompt = aiService.buildSystemPrompt({ name: 'N' }, { name: 'L' }, null);

    test('si get_price/check_stock fallan sobre un producto del catálogo: NO usar el documento, reintentar y decir que se verificará', () => {
      expect(prompt).toMatch(/FALLO TÉCNICO DE UNA HERRAMIENTA/);
      expect(prompt).toMatch(/get_price o check_stock devuelven un error \(success:false\) sobre un producto que search_products SÍ encontró en el catálogo/);
      expect(prompt).toMatch(/NO uses documentFallback ni el documento para el precio ni el stock de ese producto/);
      expect(prompt).toMatch(/sin dar ningún número/);
      expect(prompt).toMatch(/un error técnico de esas herramientas no significa que el producto no exista/);
    });

    test('para un producto FUERA del catálogo el documento sigue valiendo (no se rompió la Etapa C)', () => {
      expect(prompt).toMatch(/si search_products no encuentra el producto/);
      expect(prompt).toMatch(/mirá primero si search_products te devolvió documentFallback/);
      expect(prompt).toMatch(/Si el producto NO existe en el catálogo \(o el catálogo está vacío\), podés usar el documento informativo/);
    });
  });

  describe('flujo completo con OpenAI simulado', () => {
    test('get_price FALLA tras encontrar el producto: el modelo recibe el error + aviso, ningún precio y ningún documentFallback', async () => {
      jest.spyOn(productService, 'consultarPrecio').mockRejectedValue(new Error('timeout de la base de datos'));
      createSpy
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_1', 'search_products', { query: 'aceite de moringa' })]))
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_2', 'get_price', { productId: producto._id.toString() })]))
        .mockResolvedValueOnce(final('Dejame verificar el precio y te aviso.'));

      const resultado = await correrTurno();
      expect(resultado.reply).toBe('Dejame verificar el precio y te aviso.');

      const fallo = mensajeTool(2, 'call_2'); // lo que ve el modelo al redactar la respuesta final
      expect(fallo).toMatchObject({ success: false, error: expect.stringContaining('timeout de la base de datos'), aviso: expect.stringMatching(/no inventes/) });
      const todo = JSON.stringify(createSpy.mock.calls[2][0].messages.filter((m) => m.role === 'tool'));
      expect(todo).not.toContain('"price"');
      expect(todo).not.toContain('documentFallback'); // search_products encontró el producto: no hay respaldo del PDF que ofrecerle
      expect(todo).not.toMatch(/999/); // el precio del PDF nunca entra en el turno

      // y el prompt de ese turno trae la regla
      expect(createSpy.mock.calls[2][0].messages[0].content).toMatch(/NO uses documentFallback ni el documento para el precio/);
      // el aviso queda también en el historial guardado
      const guardada = await Conversation.findById(conversation._id);
      const guardadoTool = guardada.messages.filter((m) => m.role === 'tool' && m.name === 'get_price').pop();
      expect(JSON.parse(guardadoTool.content).aviso).toMatch(/no inventes/);
    });

    test('el caso de producción: el modelo manda el slug a get_price tras buscar el producto → recibe el precio REAL del catálogo, sin error', async () => {
      createSpy
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_1', 'search_products', { query: 'aceite de moringa' })]))
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_2', 'get_price', { productId: SLUG })]))
        .mockResolvedValueOnce(final('Cuesta S/ 80.'));

      await correrTurno();

      expect(mensajeTool(2, 'call_2')).toMatchObject({ success: true, price: 80, currency: 'PEN', priceAvailable: true });
      expect(errorSpy).not.toHaveBeenCalled(); // antes: "error ejecutando tool get_price: Cast to ObjectId failed"
    });

    test('el slug SIN haber buscado antes: el modelo recibe cómo corregirlo (search_products) y el aviso; sin error de Mongo', async () => {
      createSpy
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_1', 'get_price', { productId: SLUG })]))
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_2', 'search_products', { query: 'aceite de moringa' })]))
        .mockResolvedValueOnce(conToolCalls([toolCallMock('call_3', 'get_price', {})]))
        .mockResolvedValueOnce(final('Cuesta S/ 80.'));

      await correrTurno();

      const primero = mensajeTool(1, 'call_1');
      expect(primero).toMatchObject({ success: false, error: expect.stringMatching(/search_products/), aviso: expect.stringMatching(/no inventes/) });
      expect(JSON.stringify(primero)).not.toMatch(/Cast to|ObjectId failed/);
      expect(mensajeTool(3, 'call_3')).toMatchObject({ success: true, price: 80 });
    });
  });
});
