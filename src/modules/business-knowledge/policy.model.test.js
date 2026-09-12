// Test real (Jest, Mongo real) del modelo Policy — CREA SALES AI™ C.2
// Business Brain: Policies + FAQ V1, Etapa 2/11. Cubre el índice único
// {business,code}, las 3 invariantes de negocio que viven en el schema
// (vigencia, handoff⇒handoffReason, appliesToAll excluyente con scope
// específico) y los defaults.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('../products/product.model');
const Policy = require('./policy.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_policy_model';

describe('Policy (modelo)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const datosValidos = (overrides = {}) => ({
    business: business._id,
    code: 'RETURNS-001',
    title: 'Cambios de productos estándar',
    category: 'exchanges',
    policyType: 'rule',
    statement: 'Se aceptan cambios hasta 7 días después de la compra con comprobante.',
    ...overrides,
  });

  test('crea una Policy válida con los defaults documentados', async () => {
    const policy = await Policy.create(datosValidos());
    expect(policy.status).toBe('draft');
    expect(policy.priority).toBe(50);
    expect(policy.version).toBe(1);
    expect(policy.scope.appliesToAll).toBe(true);
    expect(policy.action.responseMode).toBe('answer');
    expect(policy.code).toBe('RETURNS-001'); // ya venía en mayúsculas
  });

  test('code se normaliza a mayúsculas', async () => {
    const policy = await Policy.create(datosValidos({ code: 'returns-002' }));
    expect(policy.code).toBe('RETURNS-002');
  });

  test('{business, code} único: no se puede crear 2 Policies con el mismo code en el mismo negocio', async () => {
    await Policy.create(datosValidos({ code: 'RETURNS-001' }));
    await expect(Policy.create(datosValidos({ code: 'returns-001', title: 'Otra' }))).rejects.toThrow(/duplicate key|E11000/);
  });

  test('el mismo code SÍ puede existir en 2 negocios distintos', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    await Policy.create(datosValidos({ business: business._id }));
    const enOtro = await Policy.create(datosValidos({ business: otroBusiness._id }));
    expect(enOtro.code).toBe('RETURNS-001');
  });

  test.each(['business', 'code', 'title', 'category', 'policyType', 'statement'])('%s es requerido', async (campo) => {
    const datos = datosValidos();
    delete datos[campo];
    await expect(Policy.create(datos)).rejects.toThrow();
  });

  test('title debe tener al menos 3 caracteres', async () => {
    await expect(Policy.create(datosValidos({ title: 'ab' }))).rejects.toThrow();
  });

  test('priority debe ser un entero', async () => {
    await expect(Policy.create(datosValidos({ priority: 50.5 }))).rejects.toThrow(/entero/);
  });

  test('priority fuera de 0-100 es inválido', async () => {
    await expect(Policy.create(datosValidos({ priority: 101 }))).rejects.toThrow();
    await expect(Policy.create(datosValidos({ priority: -1 }))).rejects.toThrow();
  });

  describe('vigencia (documento §6.2 regla 6)', () => {
    test('effectiveUntil posterior a effectiveFrom es válido', async () => {
      const policy = await Policy.create(datosValidos({
        effectiveFrom: new Date('2026-01-01'),
        effectiveUntil: new Date('2026-12-31'),
      }));
      expect(policy.effectiveUntil.getTime()).toBeGreaterThan(policy.effectiveFrom.getTime());
    });

    test('effectiveUntil igual o anterior a effectiveFrom es inválido', async () => {
      await expect(Policy.create(datosValidos({
        effectiveFrom: new Date('2026-12-31'),
        effectiveUntil: new Date('2026-01-01'),
      }))).rejects.toThrow(/effectiveUntil/);
    });
  });

  describe('action.responseMode:"handoff" (documento §6.2 regla 9)', () => {
    test('handoff sin handoffReason es inválido', async () => {
      await expect(Policy.create(datosValidos({
        action: { responseMode: 'handoff' },
      }))).rejects.toThrow(/handoffReason/);
    });

    test('handoff con handoffReason es válido', async () => {
      const policy = await Policy.create(datosValidos({
        action: { responseMode: 'handoff', handoffReason: 'Reclamo formal' },
      }));
      expect(policy.action.responseMode).toBe('handoff');
    });

    test('responseMode distinto de handoff nunca exige handoffReason', async () => {
      const policy = await Policy.create(datosValidos({ action: { responseMode: 'answer' } }));
      expect(policy.action.handoffReason).toBeNull();
    });
  });

  describe('scope.appliesToAll excluyente con scope específico (documento §6.2 regla 11)', () => {
    test('appliesToAll:true junto con productIds es inválido', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      await expect(Policy.create(datosValidos({
        scope: { appliesToAll: true, productIds: [producto._id] },
      }))).rejects.toThrow(/appliesToAll/);
    });

    test('appliesToAll:false con productIds es válido', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      const policy = await Policy.create(datosValidos({
        scope: { appliesToAll: false, productIds: [producto._id] },
      }));
      expect(policy.scope.productIds).toHaveLength(1);
    });

    test('appliesToAll:true sin scope específico (default) es válido', async () => {
      const policy = await Policy.create(datosValidos());
      expect(policy.scope.appliesToAll).toBe(true);
      expect(policy.scope.productIds).toHaveLength(0);
    });
  });
});
