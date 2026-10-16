// FASE 3 / ETAPA C — el prompt fija la precedencia catálogo vs. PDF, el respaldo sin índice y los 4 materiales enviables.
const { buildSystemPrompt } = require('./ai.service');

const prompt = buildSystemPrompt({ name: 'Negocio de prueba' }, { name: 'Lead' }, null);

describe('buildSystemPrompt — Etapa C', () => {
  test('precedencia: el catálogo manda si el producto existe; si no existe (o está vacío) se puede usar el documento', () => {
    expect(prompt).toMatch(/PRECEDENCIA ENTRE CATÁLOGO Y DOCUMENTO/);
    expect(prompt).toMatch(/si el producto EXISTE en el catálogo, el catálogo manda en precio y stock/);
    expect(prompt).toMatch(/NO existe en el catálogo \(o el catálogo está vacío\)/);
    expect(prompt).toMatch(/documentFallback/);
  });

  test('sin índice del documento la IA responde con el respaldo y sin mencionar errores técnicos', () => {
    expect(prompt).toMatch(/documentStatus:"indice_no_disponible"/);
    expect(prompt).toMatch(/sin mencionar ningún error técnico al lead/);
  });

  test('los 4 materiales enviables están guiados y el PDF informativo NUNCA se envía', () => {
    ['resource:"logo"', 'resource:"business_photos"', 'resource:"presentation_video"', 'resource:"brochure"'].forEach((r) => {
      expect(prompt).toContain(r);
    });
    expect(prompt).toMatch(/El PDF informativo \(la base de conocimiento\) NUNCA se envía/);
  });
});
