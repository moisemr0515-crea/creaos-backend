// Test real (Jest, Mongo real) de faqImport.controller.js — CREA SALES
// AI™ C.2, Etapa 9/11. Mismo patrón que policyImport.controller.test.js.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const FAQ = require('./faq.model');
const { previewImport, confirmImport } = require('./faqImport.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_faq_import_controller';

const HEADERS = ['question', 'answer', 'category'];

const csvFile = (rows, name = 'faqs.csv') => ({
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

describe('faqImport.controller', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await FAQ.init();
  });

  afterAll(async () => {
    await FAQ.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await FAQ.deleteMany({});
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

    test('con archivo válido: delega a faqImportService, no persiste', async () => {
      const req = actorReq({ businessId: business._id, file: csvFile([['¿Aceptan Yape?', 'Sí aceptamos.', 'payments']]) });
      const res = mockRes();
      const next = jest.fn();

      await previewImport(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.data.resumen.validas).toBe(1);
      expect(await FAQ.countDocuments({})).toBe(0);
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

    test('con archivo válido: crea la FAQ scoped al negocio del request', async () => {
      const req = actorReq({ businessId: business._id, file: csvFile([['¿Aceptan Yape?', 'Sí aceptamos.', 'payments']]) });
      const res = mockRes();
      const next = jest.fn();

      await confirmImport(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const enDb = await FAQ.findOne({ business: business._id });
      expect(enDb).not.toBeNull();
      expect(enDb.normalizedQuestion).toBe('aceptan yape');
    });
  });
});
