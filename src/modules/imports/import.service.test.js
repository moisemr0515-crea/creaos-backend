// Test real (Jest, commiteado) del bloqueo duro de plan en la importación
// masiva (auditoría de pricing del 23/ago/2026) — procesarImportacion()
// rechaza el archivo ENTERO si excede el cupo restante de leads activos,
// antes de insertar nada, en vez de truncar o insertar parcial.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('../subscriptions/plan.model');
const Subscription = require('../subscriptions/subscription.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('../leads/lead.model');
const Import = require('./import.model');
const { procesarImportacion } = require('./import.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_import_leadlimit';

const csvBuffer = (rows) => {
  const header = 'name,phone';
  const lineas = rows.map((r, i) => `Lead ${i + 1},+5190000${String(i).padStart(4, '0')}`);
  return Buffer.from([header, ...lineas].join('\n'), 'utf8');
};

describe('import.service#procesarImportacion() — bloqueo duro de plan', () => {
  let business;
  const actorId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Import.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Import.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearSubscripcionConLimite = async (leadsPerMonth) => {
    const plan = await Plan.create({
      name: 'starter',
      displayName: 'Plan de prueba',
      price: 0,
      limits: { leadsPerMonth },
    });
    await Subscription.create({
      business: business._id,
      plan: plan._id,
      planName: plan.name,
      status: 'active',
      provider: 'free',
    });
  };

  const file = (rows) => ({
    originalname: 'leads.csv',
    buffer: csvBuffer(rows),
    size: 100,
  });

  test('inserta normalmente cuando el archivo entra dentro del límite', async () => {
    await crearSubscripcionConLimite(10);
    const resultado = await procesarImportacion(business._id, actorId, { file: file([1, 2, 3]) });

    expect(resultado.status).toBe('completed');
    expect(resultado.successCount).toBe(3);
    expect(await Lead.countDocuments({ business: business._id })).toBe(3);
  });

  test('rechaza el archivo ENTERO si excede el cupo restante — no inserta nada', async () => {
    await crearSubscripcionConLimite(2);
    const resultado = await procesarImportacion(business._id, actorId, { file: file([1, 2, 3]) });

    expect(resultado.status).toBe('failed');
    expect(resultado.successCount).toBe(0);
    expect(resultado.errors.some((e) => e.field === 'plan')).toBe(true);
    expect(await Lead.countDocuments({ business: business._id })).toBe(0);
  });

  test('cuenta los leads activos YA existentes contra el cupo disponible del archivo', async () => {
    await crearSubscripcionConLimite(3);
    const pipeline = await Pipeline.createDefault(business._id, actorId);
    // 2 leads activos ya existentes — solo queda cupo para 1 más.
    await Lead.create({ business: business._id, pipeline: pipeline._id, name: 'Existente 1', pipelineStage: 'new', activity: [] });
    await Lead.create({ business: business._id, pipeline: pipeline._id, name: 'Existente 2', pipelineStage: 'new', activity: [] });

    const resultado = await procesarImportacion(business._id, actorId, { file: file([1, 2]) }); // 2 filas, solo cabe 1

    expect(resultado.status).toBe('failed');
    expect(resultado.successCount).toBe(0);
    expect(await Lead.countDocuments({ business: business._id })).toBe(2); // sigue en 2, nada nuevo entró
  });
});
