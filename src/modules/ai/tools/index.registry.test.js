// Test real de la formalización del Tool Registry — CREA SALES AI™ C.3,
// Etapa C3.2 (Tool Registry formal). No repite la cobertura de
// comportamiento de cada tool (eso ya está en index.test.js/
// index.businessKnowledge.test.js, que siguen pasando SIN CAMBIOS después
// de este refactor) — el foco acá es el REGISTRO en sí: TOOL_REGISTRY
// como única fuente de verdad, TOOL_SCHEMAS/TOOL_EXECUTORS derivados
// correctamente, y que executeToolCall() respeta `authorization` antes de
// ejecutar (spec §5.2 — "el modelo puede solicitar una tool; el runtime
// decide si está autorizada").
const { TOOL_REGISTRY, TOOL_SCHEMAS, TOOL_EXECUTORS, executeToolCall } = require('./index');

const NOMBRES_ESPERADOS = [
  'escalate_to_human',
  'update_lead_stage',
  'search_products',
  'check_stock',
  'get_price',
  'search_business_knowledge',
];

describe('ai/tools/index — Tool Registry formal (C.3, Etapa C3.2)', () => {
  test('TOOL_REGISTRY declara exactamente las 6 tools reales, sin ninguna ficticia', () => {
    expect(TOOL_REGISTRY.map((t) => t.name).sort()).toEqual([...NOMBRES_ESPERADOS].sort());
  });

  test('cada entrada del registro tiene la forma completa de ToolDefinition (spec §5.2)', () => {
    for (const tool of TOOL_REGISTRY) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof tool.authorization).toBe('function');
      expect(typeof tool.execute).toBe('function');
    }
  });

  test('TOOL_SCHEMAS se deriva 1:1 de TOOL_REGISTRY, con el shape exacto que espera la API de OpenAI', () => {
    expect(TOOL_SCHEMAS).toHaveLength(TOOL_REGISTRY.length);
    TOOL_SCHEMAS.forEach((schema, i) => {
      const tool = TOOL_REGISTRY[i];
      expect(schema).toEqual({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    });
  });

  test('TOOL_EXECUTORS se deriva 1:1 de TOOL_REGISTRY — misma referencia de función, no una copia', () => {
    for (const tool of TOOL_REGISTRY) {
      expect(TOOL_EXECUTORS[tool.name]).toBe(tool.execute);
    }
    expect(Object.keys(TOOL_EXECUTORS).sort()).toEqual([...NOMBRES_ESPERADOS].sort());
  });

  test('las 6 tools reales siguen siempre autorizadas en V1 — mismo comportamiento que antes de esta etapa', () => {
    const context = {};
    for (const tool of TOOL_REGISTRY) {
      expect(tool.authorization(context)).toBe(true);
    }
  });

  describe('autorización en código (spec §5.2 / regla no-negociable #3: "tool authorization en código, no por obediencia del modelo")', () => {
    afterEach(() => {
      // TOOL_REGISTRY es la MISMA referencia de array que exporta el
      // módulo real — se saca cualquier entrada de prueba para no dejar
      // residuos que afecten a otro test de este archivo.
      const idx = TOOL_REGISTRY.findIndex((t) => t.name === 'fake_tool_para_test');
      if (idx !== -1) TOOL_REGISTRY.splice(idx, 1);
    });

    test('una tool con authorization() => false nunca ejecuta — el modelo la "pide", el runtime la deniega', async () => {
      const executeFalso = jest.fn().mockResolvedValue({ success: true });
      TOOL_REGISTRY.push({
        name: 'fake_tool_para_test',
        description: 'Tool de prueba, nunca autorizada.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        authorization: () => false,
        execute: executeFalso,
      });

      const toolCall = { id: 'call_x', function: { name: 'fake_tool_para_test', arguments: '{}' } };
      const resultado = await executeToolCall(toolCall, {});

      expect(resultado).toEqual({ success: false, error: 'Tool no autorizada: fake_tool_para_test' });
      expect(executeFalso).not.toHaveBeenCalled();
    });

    test('una tool con authorization() => true sí ejecuta normalmente (control positivo del test anterior)', async () => {
      const executeVerdadero = jest.fn().mockResolvedValue({ success: true, dato: 'ok' });
      TOOL_REGISTRY.push({
        name: 'fake_tool_para_test',
        description: 'Tool de prueba, siempre autorizada.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        authorization: () => true,
        execute: executeVerdadero,
      });

      const toolCall = { id: 'call_x', function: { name: 'fake_tool_para_test', arguments: '{}' } };
      const resultado = await executeToolCall(toolCall, {});

      expect(resultado).toEqual({ success: true, dato: 'ok' });
      expect(executeVerdadero).toHaveBeenCalledTimes(1);
    });
  });
});
