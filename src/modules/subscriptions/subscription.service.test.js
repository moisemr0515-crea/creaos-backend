// Test real (Jest, commiteado) de subscription.service.js#checkLeadLimit()/
// contarLeadsActivos() — reescritas en la auditoría de pricing del
// 23/ago/2026 para medir leads ACTIVOS en vivo (no isDeleted, stage que no
// sea won/lost) en vez del contador `leadsUsedThisMonth` que nunca se
// incrementaba en ningún lado.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('../leads/lead.model');
const { checkLeadLimit, contarLeadsActivos } = require('./subscription.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_subscription_leadlimit';

const STAGES_DEFAULT = [
  { key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false },
  { key: 'negotiating', name: 'Negociando', order: 2, isWon: false, isLost: false },
  { key: 'won', name: 'Ganado', order: 3, isWon: true, isLost: false },
  { key: 'lost', name: 'Perdido', order: 4, isWon: false, isLost: true },
];

const crearLeadDirecto = (businessId, pipelineId, overrides = {}) =>
  Lead.create({
    business: businessId,
    pipeline: pipelineId,
    name: overrides.name || 'Lead de prueba',
    phone: overrides.phone,
    pipelineStage: overrides.pipelineStage || 'new',
    isDeleted: overrides.isDeleted || false,
    activity: [{ type: 'created', description: 'test' }],
  });

describe('subscription.service#checkLeadLimit() / contarLeadsActivos()', () => {
  let business;
  let pipeline;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    pipeline = await Pipeline.create({
      business: business._id,
      name: 'Pipeline Principal',
      stages: STAGES_DEFAULT,
      isDefault: true,
      isActive: true,
    });
  });

  const crearSubscripcionConLimite = async (leadsPerMonth) => {
    // name: 'starter' fijo — Plan.name tiene un enum estricto
    // (plan.model.js), y beforeEach() ya limpia Plan entre tests, así que
    // no hay colisión real entre tests (ninguno llama este helper 2 veces).
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

  test('contarLeadsActivos(): cuenta solo leads no borrados y en stage que no sea won/lost', async () => {
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'new' });
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'negotiating' });
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'won' }); // no cuenta
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'lost' }); // no cuenta
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'new', isDeleted: true }); // no cuenta

    const activos = await contarLeadsActivos(business._id);
    expect(activos).toBe(2);
  });

  test('checkLeadLimit(): allowed:true mientras el conteo activo esté bajo el límite', async () => {
    await crearSubscripcionConLimite(5);
    await crearLeadDirecto(business._id, pipeline._id);
    await crearLeadDirecto(business._id, pipeline._id);

    const result = await checkLeadLimit(business._id);
    expect(result).toEqual({ allowed: true, current: 2, limit: 5 });
  });

  test('checkLeadLimit(): allowed:false al llegar exactamente al límite', async () => {
    await crearSubscripcionConLimite(2);
    await crearLeadDirecto(business._id, pipeline._id);
    await crearLeadDirecto(business._id, pipeline._id);

    const result = await checkLeadLimit(business._id);
    expect(result).toEqual({ allowed: false, current: 2, limit: 2 });
  });

  test('checkLeadLimit(): un lead ganado/perdido libera cupo (no cuenta contra el límite)', async () => {
    await crearSubscripcionConLimite(2);
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'won' });
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'won' });
    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'new' });

    // 2 ganados (no cuentan) + 1 activo — muy por debajo del límite de 2,
    // aunque el negocio tenga 3 leads en total.
    const result = await checkLeadLimit(business._id);
    expect(result).toEqual({ allowed: true, current: 1, limit: 2 });
  });

  test('checkLeadLimit(): límite -1 significa ilimitado, siempre allowed:true', async () => {
    await crearSubscripcionConLimite(-1);
    for (let i = 0; i < 5; i++) await crearLeadDirecto(business._id, pipeline._id);

    const result = await checkLeadLimit(business._id);
    expect(result).toEqual({ allowed: true, current: 5, limit: -1 });
  });

  test('checkLeadLimit(): sin Plan poblado (fallback), usa 10 — no el 5 viejo previo al fix de pricing', async () => {
    // Sin crear ninguna Subscription: getCurrentSubscription() auto-crea
    // con el plan 'starter' real (seedeado en producción con
    // leadsPerMonth:10 después de fix/plan-starter-leads-limit-mismatch).
    await Plan.create({
      name: 'starter',
      displayName: 'Starter',
      price: 0,
      limits: { leadsPerMonth: 10 },
      isActive: true,
    });

    const result = await checkLeadLimit(business._id);
    expect(result.limit).toBe(10);
  });

  test('contarLeadsActivos(): con 2 pipelines del negocio, une los stages de cierre de ambos', async () => {
    const pipeline2 = await Pipeline.create({
      business: business._id,
      name: 'Pipeline Secundario',
      stages: [
        { key: 'abierto', name: 'Abierto', order: 1, isWon: false, isLost: false },
        { key: 'cerrado_ganado', name: 'Cerrado', order: 2, isWon: true, isLost: false },
      ],
      isDefault: false,
      isActive: true,
    });

    await crearLeadDirecto(business._id, pipeline._id, { pipelineStage: 'won' }); // pipeline 1, cierre — no cuenta
    await crearLeadDirecto(business._id, pipeline2._id, { pipelineStage: 'cerrado_ganado' }); // pipeline 2, cierre — no cuenta
    await crearLeadDirecto(business._id, pipeline2._id, { pipelineStage: 'abierto' }); // pipeline 2, activo — cuenta

    const activos = await contarLeadsActivos(business._id);
    expect(activos).toBe(1);
  });
});
