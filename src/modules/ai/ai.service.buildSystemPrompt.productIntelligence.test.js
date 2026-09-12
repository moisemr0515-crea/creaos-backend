// Test real (Jest, commiteado) de ai.service.js#buildSystemPrompt() — CREA
// Product Intelligence™ V1.0, Etapa 7/10. Función pura (sin Mongo/OpenAI),
// mismo criterio que ai.service.buildSystemPrompt.personality.test.js: solo
// verifica el TEXTO del prompt, no comportamiento del modelo.
const { buildSystemPrompt } = require('./ai.service');

const NEGOCIO_BASE = { name: 'Negocio de prueba' };
const LEAD_BASE = { name: 'Juan Pérez' };

describe('ai.service#buildSystemPrompt() — CREA Product Intelligence™', () => {
  test('la regla anti-alucinación de precio/stock está SIEMPRE presente, incluso sin conversation.activeProduct', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).toMatch(/REGLA ANTI-ALUCINACIÓN/i);
    expect(prompt).toMatch(/nunca afirmes que un producto existe, tiene precio, o tiene stock/i);
    expect(prompt).toMatch(/decilo de forma natural/i);
  });

  test('instruye CUÁNDO usar las tools (documento §20), sin listar ningún producto real', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).toMatch(/search_products/);
    expect(prompt).toMatch(/check_stock/);
    expect(prompt).toMatch(/get_price/);
    // No hay ningún mecanismo en buildSystemPrompt() que liste productos —
    // esta prueba es de forma: el prompt no crece según cuántos productos
    // tenga el negocio (el catálogo se consulta vía tools, nunca se pega acá).
    expect(prompt).not.toMatch(/SKU/i);
  });

  test('sin activeProduct: no aparece el bloque de contexto de producto', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).not.toMatch(/CONTEXTO DE PRODUCTO/i);
  });

  test('con activeProduct: agrega el bloque de contexto con el nombre y la búsqueda que lo originó', () => {
    const activeProduct = { productId: 'x', name: 'Harina de Moringa Te Quiero', lastSearchQuery: 'pastillas de moringa' };
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null, activeProduct);

    expect(prompt).toMatch(/CONTEXTO DE PRODUCTO EN ESTA CONVERSACIÓN/);
    expect(prompt).toMatch(/Harina de Moringa Te Quiero/);
    expect(prompt).toMatch(/pastillas de moringa/);
  });

  test('activeProduct sin productId (objeto vacío/parcial): no rompe, no agrega el bloque', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null, {});
    expect(prompt).not.toMatch(/CONTEXTO DE PRODUCTO/i);
  });

  test('llamado con la firma vieja (sin 4to argumento): sigue funcionando, retrocompatible', () => {
    expect(() => buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null)).not.toThrow();
  });
});
