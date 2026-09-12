// Test real (Jest, Mongo real) del AgentRunTrace — CREA SALES AI™ C.3,
// Etapa C3.4 (Trace, spec §5.5). Espía logger.info() (la infraestructura
// de logging que ya existe, utils/logger.js) para verificar que
// runAgent() emite exactamente un AGENT_RUN por ejecución, con el shape
// correcto y SIN chain-of-thought (regla no-negociable #9) — nunca el
// texto de la respuesta ni los mensajes intercambiados con OpenAI.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const Conversation = require('./conversation.model');
const logger = require('../../utils/logger');
const aiService = require('./ai.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_ai_service_run_agent_trace';

const toolCallMock = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const completionConToolCalls = (toolCalls) => ({
  choices: [{ message: { content: '', tool_calls: toolCalls } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const completionFinal = (content) => ({
  choices: [{ message: { content, tool_calls: undefined } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** Del conjunto de llamadas a logger.info(), la última con el primer argumento 'AGENT_RUN'. */
const ultimoTrace = (infoSpy) => {
  const llamadaTrace = [...infoSpy.mock.calls].reverse().find(([mensaje]) => mensaje === 'AGENT_RUN');
  return llamadaTrace ? llamadaTrace[1] : undefined;
};

describe('ai.service#runAgent() — AgentRunTrace (C.3, Etapa C3.4)', () => {
  let business;
  let lead;
  let conversation;
  let createSpy;
  let infoSpy;

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
    createSpy = jest.spyOn(aiService.openai.chat.completions, 'create');
    infoSpy = jest.spyOn(logger, 'info');
  });

  const crearConversacion = async (mensajeInicial) =>
    Conversation.create({
      business: business._id,
      lead: lead._id,
      channel: 'whatsapp',
      messages: [{ role: 'user', content: mensajeInicial }],
    });

  test('emite exactamente un AGENT_RUN por ejecución, con el shape completo del AgentRunTrace', async () => {
    conversation = await crearConversacion('Hola');
    createSpy.mockResolvedValueOnce(completionFinal('¡Hola! ¿En qué te ayudo?'));

    const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });

    const llamadasTrace = infoSpy.mock.calls.filter(([mensaje]) => mensaje === 'AGENT_RUN');
    expect(llamadasTrace).toHaveLength(1);

    const trace = ultimoTrace(infoSpy);
    expect(trace).toEqual({
      correlationId: resultado.correlationId,
      tenantId: String(business._id),
      conversationId: String(conversation._id),
      leadId: String(lead._id),
      toolsUsed: [],
      outcome: 'answer',
      durationMs: expect.any(Number),
      errorCode: undefined,
      createdAt: expect.any(String),
    });
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => new Date(trace.createdAt).toISOString()).not.toThrow();
  });

  test('NUNCA incluye chain-of-thought — ni responseText, ni el contenido de los mensajes (regla no-negociable #9)', async () => {
    conversation = await crearConversacion('¿Tienen garantía?');
    createSpy.mockResolvedValueOnce(completionFinal('Contenido secreto que NUNCA debe llegar al trace estructurado.'));

    await aiService.runAgent({ conversationId: conversation._id, business, lead });

    const trace = ultimoTrace(infoSpy);
    const traceSerializado = JSON.stringify(trace);

    expect(trace).not.toHaveProperty('responseText');
    expect(trace).not.toHaveProperty('reply');
    expect(trace).not.toHaveProperty('message');
    expect(traceSerializado).not.toMatch(/Contenido secreto/);
  });

  test('toolsUsed real y outcome:"handoff" quedan reflejados en el trace', async () => {
    conversation = await crearConversacion('Quiero hablar con una persona');
    createSpy
      .mockResolvedValueOnce(completionConToolCalls([toolCallMock('call_1', 'escalate_to_human', { reason: 'x' })]))
      .mockResolvedValueOnce(completionFinal('Te derivo con un agente humano.'));

    await aiService.runAgent({ conversationId: conversation._id, business, lead });

    const trace = ultimoTrace(infoSpy);
    expect(trace.toolsUsed).toEqual(['escalate_to_human']);
    expect(trace.outcome).toBe('handoff');
  });

  test('un correlationId provisto por el caller aparece tal cual en el trace', async () => {
    conversation = await crearConversacion('Hola');
    createSpy.mockResolvedValueOnce(completionFinal('¡Hola!'));

    await aiService.runAgent({ conversationId: conversation._id, business, lead, correlationId: 'run-fijo-trace-test' });

    const trace = ultimoTrace(infoSpy);
    expect(trace.correlationId).toBe('run-fijo-trace-test');
  });

  test('outcome:"error" también emite su propio AGENT_RUN, con errorCode y toolsUsed:[]', async () => {
    conversation = await crearConversacion('Pregunta cualquiera');
    // check_stock sin productId ni activeProduct falla de inmediato
    // (success:false, sin tocar Mongo) — evita el ruido de un índice de
    // texto de Product sin inicializar, que no hace falta para este test.
    for (let i = 0; i < 5; i += 1) {
      createSpy.mockResolvedValueOnce(completionConToolCalls([toolCallMock(`call_${i}`, 'check_stock', {})]));
    }

    const resultado = await aiService.runAgent({ conversationId: conversation._id, business, lead });
    expect(resultado.outcome).toBe('error');

    const llamadasTrace = infoSpy.mock.calls.filter(([mensaje]) => mensaje === 'AGENT_RUN');
    expect(llamadasTrace).toHaveLength(1); // un solo trace, no uno colgado de un run anterior

    const trace = ultimoTrace(infoSpy);
    expect(trace).toMatchObject({
      outcome: 'error',
      toolsUsed: [],
      errorCode: expect.stringContaining('demasiadas tool calls encadenadas'),
    });
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
  });
});
