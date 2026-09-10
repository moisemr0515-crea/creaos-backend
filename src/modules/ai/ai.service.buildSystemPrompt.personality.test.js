// Test real (Jest, commiteado) de ai.service.js#buildSystemPrompt() —
// cableado del toggle "Personalidad" (crea-os-ignite, business.tsx,
// Business.aiPersonality). Antes era placeholder puro: no existía el campo
// en Mongo, y aunque hubiera existido, buildSystemPrompt() nunca lo leía —
// el tono estaba hardcodeado en la instrucción #2 del prompt, sin importar
// lo que el dueño eligiera en el dropdown.
//
// Función pura (sin Mongo/OpenAI/red) — no hace falta ningún mock ni base
// de datos real, solo objetos planos.
const { buildSystemPrompt } = require('./ai.service');

const NEGOCIO_BASE = { name: 'Negocio de prueba' };
const LEAD_BASE = { name: 'Juan Pérez' };

describe('ai.service#buildSystemPrompt() — Personalidad', () => {
  test('aiPersonality:"cercano" produce el bloque de tono cercano', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, aiPersonality: 'cercano' }, LEAD_BASE, null);
    expect(prompt).toMatch(/tono cercano y cálido/i);
    expect(prompt).not.toMatch(/tono formal y profesional/i);
    expect(prompt).not.toMatch(/tono directo y orientado a resultados/i);
  });

  test('aiPersonality:"formal" produce el bloque de tono formal', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, aiPersonality: 'formal' }, LEAD_BASE, null);
    expect(prompt).toMatch(/tono formal y profesional/i);
    expect(prompt).not.toMatch(/tono cercano y cálido/i);
  });

  test('aiPersonality:"agresivo" produce el bloque de tono directo/orientado a resultados', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, aiPersonality: 'agresivo' }, LEAD_BASE, null);
    expect(prompt).toMatch(/tono directo y orientado a resultados/i);
    expect(prompt).not.toMatch(/tono cercano y cálido/i);
  });

  test('sin aiPersonality (documento viejo, campo ausente): cae a "cercano" por default explícito, no rompe', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE }, LEAD_BASE, null);
    expect(prompt).toMatch(/tono cercano y cálido/i);
  });

  test('valor inesperado/corrupto de aiPersonality: cae a "cercano", no tira error ni deja el bloque vacío', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, aiPersonality: 'algo-que-no-existe' }, LEAD_BASE, null);
    expect(prompt).toMatch(/tono cercano y cálido/i);
  });

  test('el bloque de personalidad convive con las instrucciones del dueño (aiInstructions) sin pisarse', () => {
    const prompt = buildSystemPrompt(
      { ...NEGOCIO_BASE, aiPersonality: 'agresivo', aiInstructions: 'Nunca ofrezcas descuentos sin autorización.' },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/tono directo y orientado a resultados/i);
    expect(prompt).toMatch(/Nunca ofrezcas descuentos sin autorización\./);
  });
});
