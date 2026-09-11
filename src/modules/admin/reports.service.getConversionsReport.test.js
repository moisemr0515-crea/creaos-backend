// Test real (Jest, commiteado) de reports.service.js#getConversionsReport() —
// confirma que el "valor ganado" (wonValue, summary y byMonth) lee
// actualValue (monto real cobrado) cuando está seteado, con fallback a
// potentialValue para leads que se cerraron antes de que actualValue
// existiera (ver lead.model.js#actualValue). Antes de este fix, wonValue
// sumaba siempre potentialValue — la estimación previa al cierre — incluso
// para leads ya ganados, así que nunca reflejaba el monto real cobrado.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('../leads/lead.model');
const { getConversionsReport } = require('./reports.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_reports_conversions';

describe('reports.service#getConversionsReport() — actualValue vs potentialValue', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('wonValue usa actualValue cuando está seteado, no potentialValue', async () => {
    await Lead.create({
      business: business._id,
      name: 'Lead ganado con monto real',
      pipelineStage: 'won',
      potentialValue: 1000,
      actualValue: 750,
    });

    const report = await getConversionsReport(business._id);
    expect(report.summary.wonValue).toBe(750);
  });

  test('wonValue cae a potentialValue si actualValue no está seteado (leads viejos)', async () => {
    await Lead.create({
      business: business._id,
      name: 'Lead ganado sin monto real confirmado',
      pipelineStage: 'won',
      potentialValue: 500,
    });

    const report = await getConversionsReport(business._id);
    expect(report.summary.wonValue).toBe(500);
  });

  test('suma correctamente varios leads ganados mezclando actualValue y fallback', async () => {
    await Lead.create([
      { business: business._id, name: 'Con actualValue', pipelineStage: 'won', potentialValue: 1000, actualValue: 750 },
      { business: business._id, name: 'Sin actualValue', pipelineStage: 'won', potentialValue: 500 },
      { business: business._id, name: 'Lead abierto (no cuenta)', pipelineStage: 'new', potentialValue: 9999 },
    ]);

    const report = await getConversionsReport(business._id);
    expect(report.summary.wonValue).toBe(1250);
    expect(report.summary.wonLeads).toBe(2);
  });

  test('byMonth.value también usa actualValue con el mismo fallback', async () => {
    await Lead.create({
      business: business._id,
      name: 'Lead ganado este mes',
      pipelineStage: 'won',
      potentialValue: 1000,
      actualValue: 900,
    });

    const report = await getConversionsReport(business._id);
    const total = report.byMonth.reduce((s, m) => s + m.value, 0);
    expect(total).toBe(900);
  });
});
