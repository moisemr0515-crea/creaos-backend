// Test real (Jest, Mongo real) de defaultAgentRuntime.js#process() — CREA
// SALES AI™ C.3. No existía ningún test dedicado de esta clase hasta
// ahora. Mockea aiService.runAgent() directamente (no generateReply() ni
// OpenAI) porque el foco acá es la TRADUCCIÓN de AgentRunResult a
// AgentRuntimeOutput y, desde la Etapa C3.3, la reacción ante
// outcome:'error' — el comportamiento real de runAgent() en sí ya está
// cubierto en ai.service.runAgent.test.js.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const aiService = require('../ai/ai.service');
const DefaultAgentRuntime = require('./defaultAgentRuntime');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_default_agent_runtime';

describe('DefaultAgentRuntime#process()', () => {
  let business;
  let lead;
  let runtime;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    lead = await Lead.create({ business: business._id, name: 'Juan Pérez' });
    runtime = new DefaultAgentRuntime();
  });

  test('lead borrado entre encolar y procesar: no llama a runAgent(), devuelve reply:null/aiEnabled:false (caso borde, no un error)', async () => {
    const runAgentSpy = jest.spyOn(aiService, 'runAgent');

    const output = await runtime.process({
      conversationId: 'x',
      leadId: new mongoose.Types.ObjectId().toString(),
      businessContext: business,
    });

    expect(runAgentSpy).not.toHaveBeenCalled();
    expect(output).toMatchObject({ reply: null, actions: [], aiEnabled: false });
  });

  test('outcome:"answer" — traduce responseText a reply y tokensUsed a metadata, mismo AgentRuntimeOutput de siempre', async () => {
    jest.spyOn(aiService, 'runAgent').mockResolvedValue({
      outcome: 'answer',
      responseText: 'Hola, ¿en qué te ayudo?',
      toolsUsed: [],
      knowledgeSources: [],
      correlationId: 'run-1',
      tokensUsed: 42,
    });

    const output = await runtime.process({ conversationId: 'x', leadId: lead._id.toString(), businessContext: business });

    expect(output).toEqual({
      reply: 'Hola, ¿en qué te ayudo?',
      actions: [],
      aiEnabled: true,
      metadata: { tokensUsed: 42, model: expect.any(String) },
    });
  });

  test('outcome:"handoff"/"action"/"clarify" — el reply de texto viaja igual, aiEnabled:true (la mutación real ya la hizo la tool, no este método)', async () => {
    jest.spyOn(aiService, 'runAgent').mockResolvedValue({
      outcome: 'handoff',
      responseText: 'Te derivo con un agente humano.',
      toolsUsed: ['escalate_to_human'],
      knowledgeSources: [],
      correlationId: 'run-2',
      tokensUsed: 20,
    });

    const output = await runtime.process({ conversationId: 'x', leadId: lead._id.toString(), businessContext: business });

    expect(output.reply).toBe('Te derivo con un agente humano.');
  });

  test('leadId de un negocio y businessContext de otro (Etapa C3.6, hallazgo §5 de la auditoría de C.3) — assertTenantScope() corta ANTES de llamar a runAgent(), nunca ejecuta el agente con el catálogo/políticas de un negocio ajeno', async () => {
    const otroNegocio = await Business.create({ name: 'Otro negocio (ajeno al lead)' });
    const runAgentSpy = jest.spyOn(aiService, 'runAgent');

    await expect(
      runtime.process({ conversationId: 'x', leadId: lead._id.toString(), businessContext: otroNegocio })
    ).rejects.toThrow(/Tenant scope mismatch/);

    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  test('outcome:"error" (Etapa C3.3) — RELANZA en vez de devolver un AgentRuntimeOutput normal, para preservar el reintento/dead-letter de BullMQ', async () => {
    jest.spyOn(aiService, 'runAgent').mockResolvedValue({
      outcome: 'error',
      responseText: null,
      toolsUsed: [],
      knowledgeSources: [],
      correlationId: 'run-3',
      tokensUsed: 0,
      errorCode: 'El agente no pudo completar la respuesta (demasiadas tool calls encadenadas)',
    });

    await expect(
      runtime.process({ conversationId: 'x', leadId: lead._id.toString(), businessContext: business })
    ).rejects.toThrow(/demasiadas tool calls encadenadas/);
  });
});
