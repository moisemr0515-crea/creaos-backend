// Test real (Jest, Mongo real) de scripts/backfill-leads-pipeline.js —
// parte 2 de 3 del blueprint del incidente de producción del 11/sep/2026
// (docs/implementation/known-issues.md). Ejercita backfillLeadsPipeline()
// directo, sin pasar por el bloque CLI (guardado con require.main ===
// module, así requerir este archivo desde el test no exige
// MONGODB_URI_PROD ni intenta conectar/desconectar por su cuenta) — mismo
// patrón que migrate-automation-seeds-real-triggers.test.js.
const mongoose = require('mongoose');
const Business = require('../src/modules/businesses/business.model');
const Pipeline = require('../src/modules/pipeline/pipeline.model');
const Lead = require('../src/modules/leads/lead.model');
const { backfillLeadsPipeline } = require('./backfill-leads-pipeline');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_backfill_leads_pipeline';

describe('backfill-leads-pipeline#backfillLeadsPipeline()', () => {
  const STAGES = [{ key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false }];

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});
  });

  const crearLeadHuerfano = (business, overrides = {}) =>
    Lead.create({ business: business._id, name: 'Lead huérfano', source: 'whatsapp', ...overrides });

  test('negocio con 1 pipeline activo: sus leads huérfanos quedan con ese pipeline seteado', async () => {
    const business = await Business.create({ name: 'Negocio con 1 pipeline' });
    const pipeline = await Pipeline.create({ business: business._id, name: 'Pipeline Principal', stages: STAGES, isDefault: true, isActive: true });
    const lead1 = await crearLeadHuerfano(business, { name: 'Lead 1' });
    const lead2 = await crearLeadHuerfano(business, { name: 'Lead 2' });

    const resumen = await backfillLeadsPipeline();

    expect(resumen).toEqual({ negociosConHuerfanos: 1, negociosBackfilleados: 1, negociosSalteados: 0, totalBackfilleados: 2, salteados: [] });

    const lead1Actualizado = await Lead.findById(lead1._id);
    const lead2Actualizado = await Lead.findById(lead2._id);
    expect(lead1Actualizado.pipeline.toString()).toBe(pipeline._id.toString());
    expect(lead2Actualizado.pipeline.toString()).toBe(pipeline._id.toString());
  });

  test('negocio con 0 pipelines activos: se saltea, no se toca nada, queda logueado en el resumen', async () => {
    const business = await Business.create({ name: 'Negocio sin pipeline' });
    const lead = await crearLeadHuerfano(business);

    const resumen = await backfillLeadsPipeline();

    expect(resumen.negociosConHuerfanos).toBe(1);
    expect(resumen.negociosBackfilleados).toBe(0);
    expect(resumen.negociosSalteados).toBe(1);
    expect(resumen.salteados).toEqual([
      { business: 'Negocio sin pipeline', businessId: business._id.toString(), huerfanos: 1, pipelinesActivos: 0 },
    ]);

    const leadSinTocar = await Lead.findById(lead._id);
    expect(leadSinTocar.pipeline).toBeUndefined();
  });

  test('negocio con 2+ pipelines activos: se saltea, no se asume cuál es "el" default', async () => {
    const business = await Business.create({ name: 'Negocio con 2 pipelines' });
    await Pipeline.create({ business: business._id, name: 'Pipeline A', stages: STAGES, isDefault: true, isActive: true });
    await Pipeline.create({ business: business._id, name: 'Pipeline B', stages: STAGES, isActive: true });
    const lead = await crearLeadHuerfano(business);

    const resumen = await backfillLeadsPipeline();

    expect(resumen.negociosSalteados).toBe(1);
    expect(resumen.salteados[0].pipelinesActivos).toBe(2);

    const leadSinTocar = await Lead.findById(lead._id);
    expect(leadSinTocar.pipeline).toBeUndefined();
  });

  test('un lead que YA tiene pipeline seteado no se toca (no se pisa con el pipeline "equivocado")', async () => {
    const business = await Business.create({ name: 'Negocio con lead ya migrado' });
    const pipelineReal = await Pipeline.create({ business: business._id, name: 'Pipeline Principal', stages: STAGES, isDefault: true, isActive: true });
    const otroPipelineId = new mongoose.Types.ObjectId(); // simula un pipeline ya asignado (aunque no exista más, no es el caso de este test)
    const leadYaMigrado = await crearLeadHuerfano(business, { name: 'Ya migrado', pipeline: otroPipelineId });
    const leadHuerfano = await crearLeadHuerfano(business, { name: 'Huérfano de verdad' });

    const resumen = await backfillLeadsPipeline();

    expect(resumen.totalBackfilleados).toBe(1); // solo el huérfano real

    const leadYaMigradoSinTocar = await Lead.findById(leadYaMigrado._id);
    expect(leadYaMigradoSinTocar.pipeline.toString()).toBe(otroPipelineId.toString()); // intacto, no se pisó

    const leadHuerfanoActualizado = await Lead.findById(leadHuerfano._id);
    expect(leadHuerfanoActualizado.pipeline.toString()).toBe(pipelineReal._id.toString());
  });

  test('idempotente: correrlo una segunda vez no encuentra nada más para backfillear', async () => {
    const business = await Business.create({ name: 'Negocio de prueba' });
    await Pipeline.create({ business: business._id, name: 'Pipeline Principal', stages: STAGES, isDefault: true, isActive: true });
    await crearLeadHuerfano(business);

    await backfillLeadsPipeline(); // primera corrida
    const segunda = await backfillLeadsPipeline(); // segunda corrida

    expect(segunda).toEqual({ negociosConHuerfanos: 0, negociosBackfilleados: 0, negociosSalteados: 0, totalBackfilleados: 0, salteados: [] });
  });

  test('negocio sin ningún lead huérfano no aparece en el resumen (nada que hacer, nada que loguear)', async () => {
    const business = await Business.create({ name: 'Negocio limpio' });
    const pipeline = await Pipeline.create({ business: business._id, name: 'Pipeline Principal', stages: STAGES, isDefault: true, isActive: true });
    await Lead.create({ business: business._id, name: 'Ya con pipeline', pipeline: pipeline._id });

    const resumen = await backfillLeadsPipeline();

    expect(resumen).toEqual({ negociosConHuerfanos: 0, negociosBackfilleados: 0, negociosSalteados: 0, totalBackfilleados: 0, salteados: [] });
  });
});
