// Test real (Jest, Mongo real) de policy.controller.js — CREA SALES AI™
// C.2, Etapa 5/11 (CRUD API + RBAC). Mismo patrón exacto que
// product.controller.test.js: se invoca el controller directamente con
// req/res/next mockeados, sin pasar por Express ni por los middlewares de
// auth/tenant/rbac (esos ya tienen su propia cobertura genérica) — el foco
// acá es: validación (Joi), delegación correcta a policy.service.js, y que
// `business` SIEMPRE salga de `req.businessId`, nunca de algo que el
// cliente mande en el body/query.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Policy = require('./policy.model');
const {
  createPolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  archivePolicy,
} = require('./policy.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_policy_controller';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const actorReq = (overrides = {}) => ({
  user: { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' },
  body: {},
  query: {},
  params: {},
  ...overrides,
});

describe('policy.controller', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Policy.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const datosValidos = (overrides = {}) => ({
    code: 'RETURNS-001',
    title: 'Cambios de productos estándar',
    category: 'exchanges',
    policyType: 'rule',
    statement: 'Se aceptan cambios hasta 7 días después de la compra.',
    ...overrides,
  });

  describe('createPolicy', () => {
    test('201 con datos válidos, persiste scoped al negocio del request', async () => {
      const req = actorReq({ businessId: business._id, body: datosValidos() });
      const res = mockRes();
      const next = jest.fn();

      await createPolicy(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.policy.code).toBe('RETURNS-001');

      const enDb = await Policy.findById(body.data.policy._id);
      expect(enDb.business.toString()).toBe(business._id.toString());
      expect(enDb.createdBy.toString()).toBe(req.user._id.toString());
    });

    test('ignora `business`/`version`/`source` enviados en el body — siempre usa req.businessId y controla el resto el service', async () => {
      const otroBusinessId = new mongoose.Types.ObjectId();
      const req = actorReq({
        businessId: business._id,
        body: { ...datosValidos(), business: otroBusinessId.toString(), version: 99, source: { type: 'import' } },
      });
      const res = mockRes();
      const next = jest.fn();

      await createPolicy(req, res, next);

      const body = res.json.mock.calls[0][0];
      const enDb = await Policy.findById(body.data.policy._id);
      expect(enDb.business.toString()).toBe(business._id.toString());
      expect(enDb.version).toBe(1);
      expect(enDb.source.type).toBe('manual');
    });

    test.each([
      ['code faltante', { title: 'T', category: 'other', policyType: 'rule', statement: 'S' }],
      ['title muy corto', { ...datosValidos(), title: 'ab' }],
      ['category inválida', { ...datosValidos(), category: 'no-existe' }],
      ['policyType inválido', { ...datosValidos(), policyType: 'no-existe' }],
      ['priority fuera de rango', { ...datosValidos(), priority: 150 }],
    ])('rechaza con 400: %s', async (_desc, body) => {
      const req = actorReq({ businessId: business._id, body });
      const res = mockRes();
      const next = jest.fn();

      await createPolicy(req, res, next);

      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('code duplicado en el mismo negocio: 409, propagado desde el service', async () => {
      await Policy.create({ business: business._id, ...datosValidos() });

      const req = actorReq({ businessId: business._id, body: datosValidos({ title: 'Otra policy' }) });
      const res = mockRes();
      const next = jest.fn();

      await createPolicy(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  describe('getPolicy', () => {
    test('200 con la policy', async () => {
      const policy = await Policy.create({ business: business._id, ...datosValidos() });
      const req = actorReq({ businessId: business._id, params: { id: policy._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await getPolicy(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].data.policy._id.toString()).toBe(policy._id.toString());
    });

    test('404 si la policy es de otro negocio (aislamiento por tenant)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const policy = await Policy.create({ business: otroBusiness._id, ...datosValidos() });

      const req = actorReq({ businessId: business._id, params: { id: policy._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await getPolicy(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('listPolicies', () => {
    test('pagina con meta y filtra por category', async () => {
      await Policy.create({ business: business._id, ...datosValidos({ code: 'A', category: 'returns' }) });
      await Policy.create({ business: business._id, ...datosValidos({ code: 'B', category: 'payments' }) });

      const req = actorReq({ businessId: business._id, query: { category: 'returns' } });
      const res = mockRes();
      const next = jest.fn();

      await listPolicies(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.policies).toHaveLength(1);
      expect(body.data.policies[0].code).toBe('A');
      expect(body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
    });

    test('query inválida (page negativo) → 400', async () => {
      const req = actorReq({ businessId: business._id, query: { page: -1 } });
      const res = mockRes();
      const next = jest.fn();

      await listPolicies(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('updatePolicy', () => {
    test('actualiza campos válidos e incrementa version', async () => {
      const policy = await Policy.create({ business: business._id, ...datosValidos() });
      const req = actorReq({
        businessId: business._id,
        params: { id: policy._id.toString() },
        body: { statement: 'Texto nuevo' },
      });
      const res = mockRes();
      const next = jest.fn();

      await updatePolicy(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.policy.statement).toBe('Texto nuevo');
      expect(body.data.policy.version).toBe(2);
    });

    test('body vacío → 400 (Joi .min(1))', async () => {
      const policy = await Policy.create({ business: business._id, ...datosValidos() });
      const req = actorReq({ businessId: business._id, params: { id: policy._id.toString() }, body: {} });
      const res = mockRes();
      const next = jest.fn();

      await updatePolicy(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('no puede editar una policy de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const policy = await Policy.create({ business: otroBusiness._id, ...datosValidos() });

      const req = actorReq({
        businessId: business._id,
        params: { id: policy._id.toString() },
        body: { statement: 'x' },
      });
      const res = mockRes();
      const next = jest.fn();

      await updatePolicy(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('archivePolicy', () => {
    test('DELETE archiva (status:"archived"), nunca borra el documento', async () => {
      const policy = await Policy.create({ business: business._id, ...datosValidos(), status: 'active' });
      const req = actorReq({ businessId: business._id, params: { id: policy._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await archivePolicy(req, res, next);

      expect(res.json.mock.calls[0][0].data.policy.status).toBe('archived');
      const enDb = await Policy.findById(policy._id);
      expect(enDb).not.toBeNull();
      expect(enDb.status).toBe('archived');
    });
  });
});
