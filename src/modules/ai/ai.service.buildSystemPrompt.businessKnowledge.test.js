// Test real (Jest, commiteado) de ai.service.js#buildSystemPrompt() — CREA
// SALES AI™ C.2, Etapa 6/11. Función pura (sin Mongo/OpenAI), mismo
// criterio que ai.service.buildSystemPrompt.productIntelligence.test.js.
const { buildSystemPrompt } = require('./ai.service');

const NEGOCIO_BASE = { name: 'Negocio de prueba' };
const LEAD_BASE = { name: 'Juan Pérez' };

describe('ai.service#buildSystemPrompt() — CREA SALES AI™ C.2 (Business Brain)', () => {
  test('el bloque de políticas/FAQ está SIEMPRE presente, incluso sin conversation.activeProduct', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).toMatch(/POLÍTICAS, PREGUNTAS FRECUENTES Y DOCUMENTO DEL NEGOCIO/i);
    expect(prompt).toMatch(/search_business_knowledge/);
  });

  test('instruye cómo interpretar needsClarification/conflictDetected/responseMode, sin listar ninguna policy real', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).toMatch(/needsClarification/);
    expect(prompt).toMatch(/conflictDetected/);
    expect(prompt).toMatch(/handoff/);
    expect(prompt).toMatch(/escalate_to_human/);
  });

  test('el bloque de Business Brain aparece DESPUÉS del de catálogo de productos (dominios hermanos, documento §1.2)', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    const idxProducto = prompt.indexOf('CATÁLOGO DE PRODUCTOS');
    const idxKnowledge = prompt.indexOf('POLÍTICAS, PREGUNTAS FRECUENTES Y DOCUMENTO DEL NEGOCIO');
    expect(idxProducto).toBeGreaterThan(-1);
    expect(idxKnowledge).toBeGreaterThan(idxProducto);
  });

  test('llamado con la firma vieja (sin 4to argumento): sigue funcionando, retrocompatible', () => {
    expect(() => buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null)).not.toThrow();
  });

  // Bloque 3 (§45-56, 20/sep/2026) — RAG del PDF: documentChunks entra al
  // mismo bloque de guidance, con la regla de prioridad de fuentes (punto
  // 5) y el fallback anti-alucinación (punto 6, misma frase canónica que
  // el fallback de fotos del Bloque 2).
  test('instruye sobre documentChunks: solo info general, NUNCA precio/stock (la barrera real ya descarta esos chunks, esto es la instrucción complementaria)', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).toMatch(/documentChunks/);
    expect(prompt).toMatch(/NUNCA para precio o stock/);
    expect(prompt).toMatch(/get_price\/check_stock/);
  });

  test('fallback anti-alucinación cubre policy, FAQ Y fragmento de documento (no solo los primeros 2)', () => {
    const prompt = buildSystemPrompt(NEGOCIO_BASE, LEAD_BASE, null);
    expect(prompt).toMatch(/ninguna policy, FAQ, ni fragmento de documento relevante/);
    expect(prompt).toMatch(/no tengo esa información ahora mismo/);
  });
});
