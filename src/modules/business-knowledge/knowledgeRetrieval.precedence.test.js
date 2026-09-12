// Test real (Jest, Mongo real) de knowledgeRetrieval.service.js#resolverConocimiento
// — CREA SALES AI™ C.2, Etapa 4/11 (precedencia + ranking + detección de
// conflicto/ambigüedad, documento §10). Cubre específicamente los casos
// de aceptación TC-03/04/05/06/07/08/10/12/15 del documento §23.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('../products/product.model');
const Policy = require('./policy.model');
const FAQ = require('./faq.model');
const { resolverConocimiento } = require('./knowledgeRetrieval.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_knowledge_precedence';

describe('knowledgeRetrieval.service#resolverConocimiento — precedencia y conflictos (Etapa 4/11)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearPolicy = (overrides = {}) =>
    Policy.create({
      business: business._id,
      code: overrides.code || `POL-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      title: 'Policy de prueba',
      category: 'returns',
      policyType: 'rule',
      statement: 'Statement de prueba',
      status: 'active',
      priority: 50,
      scope: { appliesToAll: true },
      ...overrides,
    });

  const crearFAQ = (overrides = {}) =>
    FAQ.create({
      business: business._id,
      question: '¿Pregunta de prueba?',
      answer: 'Respuesta de prueba',
      category: 'returns',
      status: 'active',
      priority: 50,
      scope: { appliesToAll: true },
      ...overrides,
    });

  test('TC-03 — Policy específica vence a la general, sin importar priority', async () => {
    const productoX = await Product.create({ business: business._id, sku: 'X', name: 'Producto X' });

    await crearPolicy({
      code: 'GENERAL',
      priority: 100,
      statement: 'Cambios hasta 7 días',
      scope: { appliesToAll: true },
    });
    await crearPolicy({
      code: 'ESPECIFICA',
      priority: 1,
      statement: 'Producto X no admite cambios por ser personalizado',
      scope: { appliesToAll: false, productIds: [productoX._id] },
    });

    const resultado = await resolverConocimiento(business._id, 'cambios', { productIds: [productoX._id.toString()] });

    expect(resultado.policies[0].code).toBe('ESPECIFICA');
    expect(resultado.needsClarification).toBe(false);
  });

  test('TC-04 — Policy vencida (effectiveUntil pasado) nunca se resuelve', async () => {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await crearPolicy({ effectiveUntil: ayer });

    const resultado = await resolverConocimiento(business._id);
    expect(resultado.policies).toHaveLength(0);
  });

  test('TC-05 — Policy en draft nunca llega al agente', async () => {
    await crearPolicy({ status: 'draft' });

    const resultado = await resolverConocimiento(business._id);
    expect(resultado.policies).toHaveLength(0);
  });

  test('TC-06 — Cross-tenant: la resolución de A nunca trae datos de B', async () => {
    const businessB = await Business.create({ name: 'Negocio B' });
    await Policy.create({
      business: businessB._id,
      code: 'B-POL',
      title: 'Policy de B',
      category: 'returns',
      policyType: 'rule',
      statement: 'Statement de B',
      status: 'active',
      scope: { appliesToAll: true },
    });
    await FAQ.create({
      business: businessB._id,
      question: '¿Aceptan Yape?',
      answer: 'Respuesta de B',
      category: 'payments',
      status: 'active',
      scope: { appliesToAll: true },
    });

    const resultado = await resolverConocimiento(business._id);
    expect(resultado.policies).toHaveLength(0);
    expect(resultado.faqs).toHaveLength(0);
  });

  test('TC-07 — Desconocido: sin evidencia, no fuerza aclaración ni inventa conflicto', async () => {
    const resultado = await resolverConocimiento(business._id, 'garantía de por vida');
    expect(resultado.policies).toHaveLength(0);
    expect(resultado.faqs).toHaveLength(0);
    expect(resultado.needsClarification).toBe(false);
    expect(resultado.conflictDetected).toBe(false);
  });

  test('TC-08 — Ambigüedad: el tema varía por producto y no se conoce el producto', async () => {
    const productoX = await Product.create({ business: business._id, sku: 'X', name: 'Producto X' });

    await crearPolicy({
      code: 'GENERAL',
      category: 'returns',
      statement: 'Cambios hasta 7 días',
      scope: { appliesToAll: true },
    });
    await crearPolicy({
      code: 'VARIANTE-X',
      category: 'returns',
      statement: 'Producto X no admite cambios',
      scope: { appliesToAll: false, productIds: [productoX._id] },
    });

    // Sin productIds en el contexto — no se sabe de qué producto habla el lead.
    const resultado = await resolverConocimiento(business._id, 'cambios devolucion', {});

    expect(resultado.needsClarification).toBe(true);
  });

  test('TC-08 (control) — con productIds en el contexto, NO es ambiguo', async () => {
    const productoX = await Product.create({ business: business._id, sku: 'X', name: 'Producto X' });
    const productoY = await Product.create({ business: business._id, sku: 'Y', name: 'Producto Y' });

    await crearPolicy({ code: 'GENERAL', category: 'returns', statement: 'Cambios hasta 7 días', scope: { appliesToAll: true } });
    await crearPolicy({
      code: 'VARIANTE-X',
      category: 'returns',
      statement: 'Producto X no admite cambios',
      scope: { appliesToAll: false, productIds: [productoX._id] },
    });

    const resultado = await resolverConocimiento(business._id, 'cambios', { productIds: [productoY._id.toString()] });
    expect(resultado.needsClarification).toBe(false);
    expect(resultado.policies[0].code).toBe('GENERAL');
  });

  test('TC-10 — FAQ independiente contradice a la Policy activa: Policy gana y se registra conflicto', async () => {
    await crearPolicy({
      code: 'RETURNS-7D',
      category: 'returns',
      statement: 'Las devoluciones se aceptan dentro de 7 días',
    });
    await crearFAQ({
      question: '¿Cuál es la política de devolución?',
      answer: 'Tenés 15 días para hacer una devolución',
      category: 'returns',
      // independiente — sin linkedPolicyIds
    });

    const resultado = await resolverConocimiento(business._id, 'devolución');

    expect(resultado.conflictDetected).toBe(true);
    expect(resultado.policies[0].code).toBe('RETURNS-7D');
  });

  test('TC-10 (control) — FAQ vinculada a la Policy NO cuenta como conflicto', async () => {
    const policy = await crearPolicy({
      code: 'RETURNS-7D',
      category: 'returns',
      statement: 'Las devoluciones se aceptan dentro de 7 días',
    });
    await crearFAQ({
      question: '¿Cuál es la política de devolución?',
      answer: 'Tenés 7 días para hacer una devolución',
      category: 'returns',
      linkedPolicyIds: [policy._id],
    });

    const resultado = await resolverConocimiento(business._id, 'devolución');
    expect(resultado.conflictDetected).toBe(false);
  });

  test('TC-12 — Cambio de versión: v1 archivada, v2 activa → se resuelve v2', async () => {
    await crearPolicy({ code: 'VERSIONADA', status: 'archived', version: 1, statement: 'Versión vieja' });
    await crearPolicy({ code: 'VERSIONADA-V2', status: 'active', version: 2, statement: 'Versión nueva' });

    const resultado = await resolverConocimiento(business._id);
    expect(resultado.policies).toHaveLength(1);
    expect(resultado.policies[0].code).toBe('VERSIONADA-V2');
  });

  test('TC-15 — Policy futura (effectiveFrom mañana) no se usa hoy', async () => {
    const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await crearPolicy({ effectiveFrom: manana });

    const resultado = await resolverConocimiento(business._id);
    expect(resultado.policies).toHaveLength(0);
  });

  test('desempate dentro del mismo nivel de especificidad: priority más alta gana', async () => {
    await crearPolicy({ code: 'BAJA', priority: 10 });
    await crearPolicy({ code: 'ALTA', priority: 90 });

    const resultado = await resolverConocimiento(business._id);
    expect(resultado.policies.map((p) => p.code)).toEqual(['ALTA', 'BAJA']);
  });

  test('cada resolución genera un traceId distinto', async () => {
    await crearPolicy();
    const r1 = await resolverConocimiento(business._id);
    const r2 = await resolverConocimiento(business._id);
    expect(r1.traceId).not.toBe(r2.traceId);
    expect(r1.traceId).toMatch(/^kb_/);
  });
});
