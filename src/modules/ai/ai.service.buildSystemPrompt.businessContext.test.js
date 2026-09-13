// Test real (Jest, función pura sin Mongo/OpenAI/red) de
// ai.service.js#buildSystemPrompt() — auditoría de contexto del agente
// (12/sep/2026): averageTicket/currency/website existían en el schema de
// Business y llegaban intactos al objeto `business` (documento completo,
// sin .select() que los excluya) pero nunca se interpolaban en el prompt.
// No era un bug de transporte — la línea de interpolación nunca se
// escribió, a diferencia de productDescription/targetCustomer, que sí la
// tienen desde antes.
const { buildSystemPrompt } = require('./ai.service');

const NEGOCIO_BASE = { name: 'CREA OS' };
const LEAD_BASE = { name: 'Lead de prueba' };

describe('ai.service#buildSystemPrompt() — averageTicket/currency/website (GAP 1 y 2)', () => {
  test('negocio con averageTicket y currency completos: ambos aparecen en el prompt', () => {
    const prompt = buildSystemPrompt(
      { ...NEGOCIO_BASE, averageTicket: 98, currency: 'PEN' },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/Ticket promedio: 98 PEN/);
  });

  test('negocio con website completo: aparece en el prompt', () => {
    const prompt = buildSystemPrompt(
      { ...NEGOCIO_BASE, website: 'https://creaemprendedores.com' },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/Sitio web: https:\/\/creaemprendedores\.com/);
  });

  test('negocio sin averageTicket/currency/website (no completó el onboarding): no aparecen líneas vacías ni rotas', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE }, LEAD_BASE, null);
    expect(prompt).not.toMatch(/Ticket promedio/);
    expect(prompt).not.toMatch(/Sitio web/);
  });

  test('averageTicket sin currency (documento viejo, campo ausente): igual muestra el ticket, sin "undefined" pegado', () => {
    const prompt = buildSystemPrompt(
      { ...NEGOCIO_BASE, averageTicket: 500, currency: null },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/Ticket promedio: 500\n/);
    expect(prompt).not.toMatch(/undefined|null/);
  });

  test('caso real CREA OS: productDescription, targetCustomer, averageTicket, currency y website conviven en el mismo bloque sin pisarse', () => {
    const prompt = buildSystemPrompt(
      {
        name: 'CREA OS',
        productDescription: 'Software SaaS de ventas con IA',
        targetCustomer: 'Emprendedores y equipos comerciales',
        averageTicket: 98,
        currency: 'PEN',
        website: 'https://creaemprendedores.com',
      },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/Qué vende: Software SaaS de ventas con IA/);
    expect(prompt).toMatch(/Cliente ideal: Emprendedores y equipos comerciales/);
    expect(prompt).toMatch(/Ticket promedio: 98 PEN/);
    expect(prompt).toMatch(/Sitio web: https:\/\/creaemprendedores\.com/);
  });
});

describe('ai.service#buildSystemPrompt() — redes sociales (facebookUrl/instagramUrl/tiktokUrl)', () => {
  test('negocio con website + las 3 redes cargadas: los 4 aparecen en el prompt', () => {
    const prompt = buildSystemPrompt(
      {
        ...NEGOCIO_BASE,
        website: 'https://creaemprendedores.com',
        facebookUrl: 'https://facebook.com/creaos',
        instagramUrl: 'https://instagram.com/creaos',
        tiktokUrl: 'https://tiktok.com/@creaos',
      },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/Sitio web: https:\/\/creaemprendedores\.com/);
    expect(prompt).toMatch(/Facebook: https:\/\/facebook\.com\/creaos/);
    expect(prompt).toMatch(/Instagram: https:\/\/instagram\.com\/creaos/);
    expect(prompt).toMatch(/TikTok: https:\/\/tiktok\.com\/@creaos/);
  });

  test('negocio sin ninguna red cargada: ninguna línea aparece', () => {
    const prompt = buildSystemPrompt({ ...NEGOCIO_BASE }, LEAD_BASE, null);
    expect(prompt).not.toMatch(/Facebook:/);
    expect(prompt).not.toMatch(/Instagram:/);
    expect(prompt).not.toMatch(/TikTok:/);
  });

  test('negocio con solo Instagram cargado (parcial): solo esa línea aparece, sin romper el resto', () => {
    const prompt = buildSystemPrompt(
      { ...NEGOCIO_BASE, instagramUrl: 'https://instagram.com/creaos' },
      LEAD_BASE,
      null,
    );
    expect(prompt).toMatch(/Instagram: https:\/\/instagram\.com\/creaos/);
    expect(prompt).not.toMatch(/Facebook:/);
    expect(prompt).not.toMatch(/TikTok:/);
  });
});
