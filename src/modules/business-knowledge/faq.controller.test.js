// Test real (Jest, Mongo real) de faq.controller.js — CREA SALES AI™ C.2,
// Etapa 5/11. Mismo patrón que policy.controller.test.js (no se repiten
// acá los comentarios ya explicados ahí).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const FAQ = require('./faq.model');
const {
  createFAQ,
  getFAQ,
  listFAQs,
  updateFAQ,
  archiveFAQ,
} = require('./faq.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_faq_controller';

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

describe('faq.controller', () => {
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

  const datosValidos = (overrides = {}) => ({
    question: '¿Aceptan Yape?',
    answer: 'Sí, aceptamos Yape y Plin.',
    category: 'payments',
    ...overrides,
  });

  describe('createFAQ', () => {
    test('201 con datos válidos, persiste scoped al negocio del request, con normalizedQuestion calculada', async () => {
      const req = actorReq({ businessId: business._id, body: datosValidos() });
      const res = mockRes();
      const next = jest.fn();

      await createFAQ(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.json.mock.calls[0][0];
      expect(body.data.faq.normalizedQuestion).toBe('aceptan yape');

      const enDb = await FAQ.findById(body.data.faq._id);
      expect(enDb.business.toString()).toBe(business._id.toString());
      expect(enDb.createdBy.toString()).toBe(req.user._id.toString());
    });

    test('ignora `business`/`normalizedQuestion` enviados en el body', async () => {
      const otroBusinessId = new mongoose.Types.ObjectId();
      const req = actorReq({
        businessId: business._id,
        body: { ...datosValidos(), business: otroBusinessId.toString(), normalizedQuestion: 'inyectado' },
      });
      const res = mockRes();
      const next = jest.fn();

      await createFAQ(req, res, next);

      const body = res.json.mock.calls[0][0];
      const enDb = await FAQ.findById(body.data.faq._id);
      expect(enDb.business.toString()).toBe(business._id.toString());
      expect(enDb.normalizedQuestion).toBe('aceptan yape');
    });

    test.each([
      ['question muy corta', { ...datosValidos(), question: 'hi' }],
      ['answer faltante', { question: '¿Pregunta válida?', category: 'payments' }],
      ['category inválida', { ...datosValidos(), category: 'no-existe' }],
    ])('rechaza con 400: %s', async (_desc, body) => {
      const req = actorReq({ businessId: business._id, body });
      const res = mockRes();
      const next = jest.fn();

      await createFAQ(req, res, next);

      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('permite 2 FAQs con la misma pregunta normalizada (decisión: no bloquear, desambiguar por prioridad)', async () => {
      await FAQ.create({ business: business._id, ...datosValidos() });

      const req = actorReq({ businessId: business._id, body: datosValidos({ question: '¿ACEPTAN YAPE?' }) });
      const res = mockRes();
      const next = jest.fn();

      await createFAQ(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('getFAQ', () => {
    test('404 si la FAQ es de otro negocio (aislamiento por tenant)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const faq = await FAQ.create({ business: otroBusiness._id, ...datosValidos() });

      const req = actorReq({ businessId: business._id, params: { id: faq._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await getFAQ(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('listFAQs', () => {
    test('pagina con meta y filtra por category', async () => {
      await FAQ.create({ business: business._id, ...datosValidos({ question: '¿Pregunta A?', category: 'payments' }) });
      await FAQ.create({ business: business._id, ...datosValidos({ question: '¿Pregunta B?', category: 'delivery' }) });

      const req = actorReq({ businessId: business._id, query: { category: 'payments' } });
      const res = mockRes();
      const next = jest.fn();

      await listFAQs(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.faqs).toHaveLength(1);
      expect(body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
    });
  });

  describe('updateFAQ', () => {
    test('actualiza campos válidos e incrementa version', async () => {
      const faq = await FAQ.create({ business: business._id, ...datosValidos() });
      const req = actorReq({
        businessId: business._id,
        params: { id: faq._id.toString() },
        body: { answer: 'Respuesta nueva' },
      });
      const res = mockRes();
      const next = jest.fn();

      await updateFAQ(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.faq.answer).toBe('Respuesta nueva');
      expect(body.data.faq.version).toBe(2);
    });

    test('no puede editar una FAQ de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const faq = await FAQ.create({ business: otroBusiness._id, ...datosValidos() });

      const req = actorReq({ businessId: business._id, params: { id: faq._id.toString() }, body: { answer: 'x' } });
      const res = mockRes();
      const next = jest.fn();

      await updateFAQ(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('archiveFAQ', () => {
    test('DELETE archiva (status:"archived"), nunca borra el documento', async () => {
      const faq = await FAQ.create({ business: business._id, ...datosValidos(), status: 'active' });
      const req = actorReq({ businessId: business._id, params: { id: faq._id.toString() } });
      const res = mockRes();
      const next = jest.fn();

      await archiveFAQ(req, res, next);

      expect(res.json.mock.calls[0][0].data.faq.status).toBe('archived');
      const enDb = await FAQ.findById(faq._id);
      expect(enDb).not.toBeNull();
      expect(enDb.status).toBe('archived');
    });
  });
});
