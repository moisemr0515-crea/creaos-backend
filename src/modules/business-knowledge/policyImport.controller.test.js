// Test real (Jest, Mongo real) de policyImport.controller.js — CREA
// SALES AI™ C.2, Etapa 9/11. Mismo patrón que productImport.controller.test.js.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Policy = require('./policy.model');
const { previewImport, confirmImport } = require('./policyImport.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_policy_import_controller';

const HEADERS = ['code', 'title', 'category', 'policyType', 'statement'];

const csvFile = (rows, name = 'policies.csv') => ({
  originalname: name,
  buffer: Buffer.from([HEADERS.join(','), ...rows.map((r) => r.join(','))].join('\n'), 'utf8'),
  mimetype: 'text/csv',
  size: 100,
});

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

describe('policyImport.controller', () => {
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

  describe('previewImport', () => {
    test('sin archivo (req.file ausente) → 400, no lanza', async () => {
      const req = actorReq({ businessId: business._id });
      const res = mockRes();
      const next = jest.fn();

      await previewImport(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('con archivo válido: delega a policyImportService, no persiste', async () => {
      const req = actorReq({ businessId: business._id, file: csvFile([['RETURNS-001', 'Cambios', 'returns', 'rule', 'Statement']]) });
      const res = mockRes();
      const next = jest.fn();

      await previewImport(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.data.resumen.validas).toBe(1);
      expect(await Policy.countDocuments({})).toBe(0);
    });
  });

  describe('confirmImport', () => {
    test('sin archivo → 400, no lanza', async () => {
      const req = actorReq({ businessId: business._id });
      const res = mockRes();
      const next = jest.fn();

      await confirmImport(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('con archivo válido: crea la Policy scoped al negocio del request', async () => {
      const req = actorReq({ businessId: business._id, file: csvFile([['RETURNS-001', 'Cambios', 'returns', 'rule', 'Statement']]) });
      const res = mockRes();
      const next = jest.fn();

      await confirmImport(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const enDb = await Policy.findOne({ business: business._id, code: 'RETURNS-001' });
      expect(enDb).not.toBeNull();
    });
  });
});
