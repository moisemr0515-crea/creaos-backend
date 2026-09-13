// Test real (Jest, función pura sin Mongo/OpenAI/red) de
// ai.service.js#buildSystemPrompt() — personalización del nombre del
// agente (12/9/2026): antes "Alex" estaba hardcodeado en la primera línea
// del prompt, único lugar del repo donde aparecía ese nombre. Ahora se lee
// de Business.agentName, con "Alex" como fallback — mismo criterio que
// aiPersonality (ver ai.service.buildSystemPrompt.personality.test.js):
// el fallback vive acá, no en el schema (Business.agentName no tiene
// default forzado).
const { buildSystemPrompt } = require('./ai.service');

const NEGOCIO_BASE = { name: 'CREA OS' };
const LEAD_BASE = { name: 'Lead de prueba' };

describe('ai.service#buildSystemPrompt() — nombre del agente (Business.agentName)', () => {
  test('negocio SIN agentName configurado: el prompt sigue diciendo "Eres Alex" (sin regresión)', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres Alex, un agente de ventas/);
  });

  test('negocio con agentName="Marina": el prompt dice "Eres Marina", no "Alex"', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: 'Marina' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres Marina, un agente de ventas/);
    expect(prompt).not.toMatch(/Eres Alex/);
  });

  test('agentName vacío ("" — documento donde el dueño borró el campo): cae al fallback "Alex", no queda "Eres ,"', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: '' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres Alex, un agente de ventas/);
  });

  test('agentName con solo espacios: se trata como vacío, cae al fallback "Alex"', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: '   ' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres Alex, un agente de ventas/);
  });

  test('agentName con espacios alrededor de un nombre real: se usa recortado ("Eres Marina", no "Eres  Marina ")', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: '  Marina  ' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres Marina, un agente de ventas/);
  });

  test('el nombre del NEGOCIO (business.name) sigue intacto e independiente del nombre del agente', () => {
    const prompt = buildSystemPrompt(
      { ...NEGOCIO_BASE, name: 'Te Quiero Industrias', agentName: 'Marina' },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/^Eres Marina, un agente de ventas profesional y empático de Te Quiero Industrias\./);
  });
});
