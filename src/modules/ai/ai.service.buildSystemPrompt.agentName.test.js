// Test real (Jest, función pura sin Mongo/OpenAI/red) de
// ai.service.js#buildSystemPrompt() — personalización del nombre del
// agente. B1.6 (auditoría Business Brain, 19/sep/2026): "Alex" era un
// nombre de persona inventado como fallback cuando Business.agentName
// estaba vacío — ningún negocio real se llama "Alex". Ahora, sin
// agentName, el agente se identifica por su ROL + el nombre real del
// NEGOCIO, nunca un nombre de persona inventado (antes de este cambio,
// estos mismos tests afirmaban "Alex" como el comportamiento correcto —
// ver historial de este archivo).
const { buildSystemPrompt } = require('./ai.service');

const NEGOCIO_BASE = { name: 'CREA OS' };
const LEAD_BASE = { name: 'Lead de prueba' };

describe('ai.service#buildSystemPrompt() — nombre del agente (Business.agentName)', () => {
  test('negocio SIN agentName configurado: usa rol + nombre del negocio, nunca "Alex"', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres un agente de ventas profesional y empático de CREA OS\./);
    expect(prompt).not.toMatch(/Alex/);
  });

  test('negocio con agentName="Marina": el prompt dice "Eres Marina", no el fallback de rol', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: 'Marina' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres Marina, un agente de ventas/);
    expect(prompt).not.toMatch(/Alex/);
  });

  test('agentName vacío ("" — documento donde el dueño borró el campo): cae al fallback de rol, no queda "Eres ,"', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: '' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres un agente de ventas profesional y empático de CREA OS\./);
    expect(prompt).not.toMatch(/Alex/);
  });

  test('agentName con solo espacios: se trata como vacío, cae al fallback de rol', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, agentName: '   ' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres un agente de ventas profesional y empático de CREA OS\./);
    expect(prompt).not.toMatch(/Alex/);
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

  test('negocio sin agentName Y con nombre real distinto: usa rol + ese nombre de negocio', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE, name: 'Nutriva' }, LEAD_BASE, null);
    expect(prompt).toMatch(/^Eres un agente de ventas profesional y empático de Nutriva\./);
  });
});
