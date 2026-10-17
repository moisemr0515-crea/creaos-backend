// update_lead_stage: el modelo debe conocer las etapas REALES del pipeline del lead (visto en producción: NUTRIVA tiene
// [new, contacted, negotiating, won, lost] y la tool le sugería "interested/proposal/negotiation"), y un fallo debe dejar
// en el log qué etapa se intentó. Mongo real; OpenAI simulado solo en el flujo completo.
const mongoose = require('mongoose');
const logger = require('../../../utils/logger');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Pipeline = require('../../pipeline/pipeline.model');
const pipelineService = require('../../pipeline/pipeline.service');
const Conversation = require('../conversation.model');
const aiService = require('../ai.service');
const { TOOL_REGISTRY, TOOL_SCHEMAS, construirToolSchemas, executeToolCall } = require('./index');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_tools_update_lead_stage';

const toolCall = (name, args, id = 'call_test_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const schemaStage = (schemas) => schemas.find((s) => s.function.name === 'update_lead_stage').function;
const completionConToolCalls = (toolCalls) => ({ choices: [{ message: { content: '', tool_calls: toolCalls } }], usage: { total_tokens: 15 } });
const completionFinal = (content) => ({ choices: [{ message: { content, tool_calls: undefined } }], usage: { total_tokens: 15 } });

describe('ai/tools — update_lead_stage y las etapas reales del pipeline', () => {
  let business;
  let lead;
  let conversation;
  let errorSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), Business.deleteMany({})]);
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
    lead = await Lead.create({ business: business._id, name: 'Ana', pipelineStage: 'new' });
    conversation = await Conversation.create({ business: business._id, lead: lead._id, channel: 'whatsapp', messages: [{ role: 'user', content: 'hola' }] });
  });

  const contexto = () => ({ conversation, business, lead });
  const etapaGuardada = async () => (await Lead.findById(lead._id)).pipelineStage;

  describe('ejecución', () => {
    test('una etapa que NO existe en el pipeline: el error trae la lista real y la etapa del lead no cambia', async () => {
      const result = await executeToolCall(toolCall('update_lead_stage', { stage: 'interested' }), contexto());

      expect(result.success).toBe(false);
      expect(result.error).toContain('[new, contacted, negotiating, won, lost]');
      expect(await etapaGuardada()).toBe('new');
    });

    test('el log del fallo incluye la etapa que intentó el modelo, y nunca el texto del cliente', async () => {
      await executeToolCall(
        toolCall('update_lead_stage', { stage: 'interested', reason: 'dijo que su DNI es 12345678' }),
        contexto()
      );

      const linea = errorSpy.mock.calls.map((c) => c[0]).find((m) => m.includes('update_lead_stage'));
      expect(linea).toContain('error ejecutando tool update_lead_stage'); // el prefijo de siempre (búsquedas en el log)
      expect(linea).toContain('"stage":"interested"');
      expect(linea).not.toContain('12345678');
    });

    test('el log recorta valores enormes', async () => {
      await executeToolCall(toolCall('update_lead_stage', { stage: 'x'.repeat(5000) }), contexto());
      const linea = errorSpy.mock.calls.map((c) => c[0]).find((m) => m.includes('update_lead_stage'));
      expect(linea.length).toBeLessThan(500);
    });

    test('una etapa válida cambia el lead', async () => {
      const result = await executeToolCall(toolCall('update_lead_stage', { stage: 'negotiating' }), contexto());
      expect(result).toMatchObject({ success: true, alreadyInStage: false, pipelineStage: 'negotiating' });
      expect(await etapaGuardada()).toBe('negotiating');
    });

    test('la misma etapa en la que ya está: alreadyInStage, sin error', async () => {
      const result = await executeToolCall(toolCall('update_lead_stage', { stage: 'new' }), contexto());
      expect(result).toMatchObject({ success: true, alreadyInStage: true });
    });

    test('sin "stage": success:false, no lanza', async () => {
      const result = await executeToolCall(toolCall('update_lead_stage', {}), contexto());
      expect(result).toEqual({ success: false, error: expect.stringContaining('stage') });
    });

    test('con un pipeline propio del negocio: valen SUS etapas y no las del pipeline por defecto', async () => {
      const propio = await Pipeline.create({
        business: business._id, name: 'Propio', isDefault: true,
        stages: [
          { key: 'inicio', name: 'Inicio', order: 1, color: '#111111' },
          { key: 'cierre', name: 'Cierre', order: 2, color: '#222222', isWon: true },
        ],
      });
      lead.pipeline = propio._id;
      await Lead.updateOne({ _id: lead._id }, { pipeline: propio._id, pipelineStage: 'inicio' });

      expect((await executeToolCall(toolCall('update_lead_stage', { stage: 'cierre' }), contexto())).success).toBe(true);
      const mala = await executeToolCall(toolCall('update_lead_stage', { stage: 'negotiating' }), contexto());
      expect(mala.success).toBe(false);
      expect(mala.error).toContain('[inicio, cierre]');
    });
  });

  describe('construirToolSchemas — el modelo ve las etapas reales', () => {
    test('update_lead_stage.stage es un enum con las claves del pipeline por defecto y la descripción las nombra', async () => {
      const f = schemaStage(await construirToolSchemas({ business, lead }));

      expect(f.parameters.properties.stage.enum).toEqual(['new', 'contacted', 'negotiating', 'won', 'lost']);
      expect(f.description).toContain('negotiating (Negociando)');
      expect(f.description).not.toContain('Etapas típicas'); // ya no se le sugieren etapas que el negocio no tiene
      expect(f.parameters.properties.stage.description).not.toContain('interested');
      expect(f.parameters.required).toEqual(['stage']); // el resto del schema no cambia
      expect(f.parameters.properties.reason).toBeDefined();
    });

    test('es universal: dos negocios con pipelines distintos reciben enums distintos', async () => {
      const otro = await Business.create({ name: 'Otro negocio' });
      const pipelineOtro = await Pipeline.create({
        business: otro._id, name: 'Otro', isDefault: true,
        stages: [{ key: 'consulta', name: 'Consulta', order: 1 }, { key: 'reserva', name: 'Reserva', order: 2 }],
      });
      const leadOtro = await Lead.create({ business: otro._id, name: 'Beto', pipeline: pipelineOtro._id });

      const a = schemaStage(await construirToolSchemas({ business, lead })).parameters.properties.stage.enum;
      const b = schemaStage(await construirToolSchemas({ business: otro, lead: leadOtro })).parameters.properties.stage.enum;

      expect(a).toEqual(['new', 'contacted', 'negotiating', 'won', 'lost']);
      expect(b).toEqual(['consulta', 'reserva']);
    });

    test('las demás tools quedan idénticas (misma referencia) y TOOL_SCHEMAS no se muta', async () => {
      const antes = JSON.stringify(TOOL_SCHEMAS);
      const schemas = await construirToolSchemas({ business, lead });

      expect(schemas).toHaveLength(TOOL_SCHEMAS.length);
      schemas.forEach((s, i) => {
        if (s.function.name !== 'update_lead_stage') expect(s).toBe(TOOL_SCHEMAS[i]);
      });
      expect(JSON.stringify(TOOL_SCHEMAS)).toBe(antes);
      expect(schemaStage(TOOL_SCHEMAS).description).toContain('Etapas típicas'); // el estático conserva la descripción de siempre
    });

    test('si no se puede leer el pipeline: fail-soft, quedan los schemas genéricos de siempre', async () => {
      jest.spyOn(pipelineService, 'obtenerPipelineEfectivo').mockRejectedValue(new Error('mongo caído'));
      expect(await construirToolSchemas({ business, lead })).toBe(TOOL_SCHEMAS);
    });

    test('un pipeline sin etapas: también queda el schema genérico (nunca un enum vacío)', async () => {
      jest.spyOn(pipelineService, 'obtenerPipelineEfectivo').mockResolvedValue({ stages: [] });
      expect(await construirToolSchemas({ business, lead })).toBe(TOOL_SCHEMAS);
    });

    test('el enum coincide con lo que valida el servidor: toda etapa del enum es aceptada', async () => {
      const enumEtapas = schemaStage(await construirToolSchemas({ business, lead })).parameters.properties.stage.enum;
      for (const stage of enumEtapas) {
        // eslint-disable-next-line no-await-in-loop
        const r = await executeToolCall(toolCall('update_lead_stage', { stage }), contexto());
        expect(r.success).toBe(true);
      }
    });
  });

  describe('contrato sobre TOOL_REGISTRY: todo parámetro "stage" rechaza basura sin filtrar errores de Mongo', () => {
    const conStage = TOOL_REGISTRY.filter((t) => 'stage' in (t.inputSchema.properties || {}));

    test('el contrato no es vacío', () => {
      expect(conStage.map((t) => t.name)).toContain('update_lead_stage');
    });

    test.each(conStage.map((t) => [t.name]))('%s', async (nombre) => {
      const result = await executeToolCall(toolCall(nombre, { stage: 'aceite_de_moringa' }), contexto());
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/Cast to|ObjectId failed|BSONError/i);
    });
  });

  describe('flujo completo con OpenAI simulado', () => {
    test('generateReply manda a OpenAI el enum real; si el modelo se equivoca recibe la lista y al reintentar el lead avanza', async () => {
      const createSpy = jest.spyOn(aiService.openai.chat.completions, 'create')
        .mockResolvedValueOnce(completionConToolCalls([toolCall('update_lead_stage', { stage: 'proposal' }, 'call_1')]))
        .mockResolvedValueOnce(completionConToolCalls([toolCall('update_lead_stage', { stage: 'negotiating' }, 'call_2')]))
        .mockResolvedValueOnce(completionFinal('Perfecto, seguimos.'));

      const resultado = await aiService.generateReply(conversation._id, business, lead);

      expect(resultado.reply).toBe('Perfecto, seguimos.');
      const herramientas = createSpy.mock.calls[0][0].tools;
      expect(schemaStage(herramientas).parameters.properties.stage.enum).toEqual(['new', 'contacted', 'negotiating', 'won', 'lost']);

      // apiMessages es el mismo array en todas las vueltas: se busca la respuesta de la tool fallida por su id.
      const respuestaTool = createSpy.mock.calls[1][0].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
      expect(JSON.parse(respuestaTool.content).error).toContain('[new, contacted, negotiating, won, lost]');
      expect(await etapaGuardada()).toBe('negotiating');
    });
  });
});
