// Criterio único: toda cantidad de dinero está en la moneda del NEGOCIO (Business.currency). Lead.currency ya no es fuente
// de verdad: los leads antiguos guardan 'USD' (default que tenía el campo) y se leen igual en la moneda del negocio.
const mongoose = require('mongoose');
const Business = require('./business.model');
const Lead = require('../leads/lead.model');
require('../users/user.model');
const { buildSystemPrompt } = require('../ai/ai.service');
const { recopilarDatosDeLeads, construirPromptDatos } = require('../missions/mission.service');
const { exportLeadsCSV, getLeadsReport } = require('../admin/reports.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_moneda_universal';

describe('prompt del agente — Valor potencial en la moneda del negocio', () => {
  const negocioPen = { name: 'Negocio PEN', currency: 'PEN', averageTicket: 120 };
  const leadAntiguo = { name: 'Ana', potentialValue: 500, currency: 'USD', pipelineStage: 'new' }; // 'USD' viejo de Atlas

  test('(a) el prompt de un lead de un negocio PEN no contiene "$" ni "USD"', () => {
    const prompt = buildSystemPrompt(negocioPen, leadAntiguo, null);
    expect(prompt).toContain('- Valor potencial: 500 PEN');
    expect(prompt).toContain('- Ticket promedio: 120 PEN');
    expect(prompt).not.toMatch(/\$/);
    expect(prompt).not.toMatch(/USD/);
  });

  test('(c) un lead antiguo con currency "USD" dentro de un negocio PEN se muestra como PEN', () => {
    expect(buildSystemPrompt(negocioPen, leadAntiguo, null)).toContain('500 PEN');
  });

  test('otra moneda del negocio se respeta; sin moneda no se inventa ninguna', () => {
    expect(buildSystemPrompt({ name: 'N', currency: 'COP' }, leadAntiguo, null)).toContain('- Valor potencial: 500 COP');
    const sinMoneda = buildSystemPrompt({ name: 'N' }, leadAntiguo, null);
    expect(sinMoneda).toContain('- Valor potencial: 500\n');
    expect(sinMoneda).not.toMatch(/USD|\$/);
  });

  test('sin valor potencial sigue diciendo "No definido"', () => {
    expect(buildSystemPrompt(negocioPen, { name: 'Ana' }, null)).toContain('- Valor potencial: No definido');
  });
});

describe('misión del día y reportes — moneda del negocio (Mongo real)', () => {
  let negocio;
  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Promise.all([Business.deleteMany({}), Lead.deleteMany({})]);
    negocio = await Business.create({ name: 'Negocio PEN', country: 'PE' }); // currency => PEN
    // Lead antiguo: currency 'USD' guardada tal cual (como en Atlas), probabilidad alta para entrar en la misión.
    await Lead.collection.insertOne({
      business: negocio._id, name: 'Lead antiguo', isDeleted: false, isArchived: false, temperature: 'hot',
      pipelineStage: 'new', potentialValue: 500, currency: 'USD', closeProbability: 80,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  test('el negocio nuevo nace en PEN y el lead nuevo ya no nace con "USD"', async () => {
    expect(negocio.currency).toBe('PEN');
    const nuevo = await Lead.create({ business: negocio._id, name: 'Lead nuevo' });
    expect(nuevo.currency).toBeNull();
  });

  test('(b)(c) la misión muestra el valor del lead antiguo en PEN, sin "$" ni "USD"', async () => {
    const datos = await recopilarDatosDeLeads(negocio._id);
    const prompt = construirPromptDatos(negocio, datos);
    expect(prompt).toContain('80% de probabilidad, 500 PEN');
    expect(prompt).not.toMatch(/\$|USD/);
  });

  test('(b)(c) el CSV de leads trae la columna Moneda en PEN aunque el lead diga USD', async () => {
    const csv = await exportLeadsCSV(negocio._id);
    const [encabezado, fila] = csv.split('\n');
    expect(encabezado).toContain('Moneda');
    const columnas = encabezado.split(',');
    const iMoneda = columnas.indexOf('Moneda');
    expect(fila.split(',')[iMoneda]).toBe('PEN');
    expect(csv).not.toContain('USD');
  });

  test('(b)(c) el reporte de leads devuelve currency PEN por lead', async () => {
    const reporte = await getLeadsReport(negocio._id);
    expect(reporte.leads).toHaveLength(1);
    expect(reporte.leads[0].currency).toBe('PEN');
  });

  test('un negocio sin moneda legible exporta la columna vacía (no inventa USD)', async () => {
    await Business.collection.updateOne({ _id: negocio._id }, { $unset: { currency: '' } });
    const csv = await exportLeadsCSV(negocio._id);
    const [encabezado, fila] = csv.split('\n');
    expect(fila.split(',')[encabezado.split(',').indexOf('Moneda')]).toBe('');
    expect(csv).not.toContain('USD');
  });
});
