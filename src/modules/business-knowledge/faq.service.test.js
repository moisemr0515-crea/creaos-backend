// Test real (Jest, Mongo real) de faq.service.js — CREA SALES AI™ C.2,
// Etapa 3/11. Mismo criterio que policy.service.test.js, con el agregado
// de validarReferencias() sobre linkedPolicyIds/linkedProductIds.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('../products/product.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const Policy = require('./policy.model');
const FAQ = require('./faq.model');

// Bloque 3 (§53, 20/sep/2026) — mismo motivo que policy.service.test.js.
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]) }));
const { generarEmbedding } = require('../../utils/embeddings');

const {
  crearFAQ,
  obtenerFAQ,
  listarFAQs,
  actualizarFAQ,
  archivarFAQ,
} = require('./faq.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_faq_service';
const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('faq.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await FAQ.init();
  });

  afterAll(async () => {
    await FAQ.deleteMany({});
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await FAQ.deleteMany({});
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearPolicyDePrueba = (biz, overrides = {}) =>
    Policy.create({
      business: biz._id,
      code: 'POL-001',
      title: 'Policy de prueba',
      category: 'returns',
      policyType: 'rule',
      statement: 'Texto de la policy',
      ...overrides,
    });

  const crearCanal = (biz) =>
    WhatsAppChannel.create({
      tenantId: biz._id,
      businessId: biz._id,
      phoneNumber: '+51900000000',
      phoneNumberId: 'phone-id-1',
      connectionType: 'PLATFORM',
    });

  const datosValidos = (overrides = {}) => ({
    question: '¿Aceptan Yape?',
    answer: 'Sí, aceptamos Yape y Plin.',
    category: 'payments',
    ...overrides,
  });

  describe('crearFAQ', () => {
    test('crea una FAQ scoped al negocio, con normalizedQuestion calculada', async () => {
      const faq = await crearFAQ(business._id, actor, datosValidos());
      expect(faq.business.toString()).toBe(business._id.toString());
      expect(faq.normalizedQuestion).toBe('aceptan yape');
    });

    test('permite 2 FAQs con la misma pregunta normalizada (decisión: no bloquear, desambiguar por prioridad)', async () => {
      await crearFAQ(business._id, actor, datosValidos({ question: '¿Aceptan Yape?' }));
      const segunda = await crearFAQ(business._id, actor, datosValidos({ question: '¿ACEPTAN YAPE?' }));
      expect(segunda.normalizedQuestion).toBe('aceptan yape');

      const total = await FAQ.countDocuments({ business: business._id, normalizedQuestion: 'aceptan yape' });
      expect(total).toBe(2);
    });

    test('rechaza linkedPolicyIds que no pertenecen a este negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const policyAjena = await crearPolicyDePrueba(otroBusiness);

      await expect(crearFAQ(business._id, actor, datosValidos({ linkedPolicyIds: [policyAjena._id] })))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    test('acepta linkedPolicyIds que sí pertenecen a este negocio', async () => {
      const policy = await crearPolicyDePrueba(business);
      const faq = await crearFAQ(business._id, actor, datosValidos({ linkedPolicyIds: [policy._id] }));
      expect(faq.linkedPolicyIds).toHaveLength(1);
    });

    test('rechaza linkedProductIds que no pertenecen a este negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const productoAjeno = await Product.create({ business: otroBusiness._id, sku: 'A', name: 'A' });

      await expect(crearFAQ(business._id, actor, datosValidos({ linkedProductIds: [productoAjeno._id] })))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    test('rechaza scope.channelIds que no pertenecen a este negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const canalAjeno = await crearCanal(otroBusiness);

      await expect(crearFAQ(business._id, actor, datosValidos({
        scope: { appliesToAll: false, channelIds: [canalAjeno._id] },
      }))).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('obtenerFAQ', () => {
    test('no encuentra una FAQ de OTRO negocio (aislamiento por tenant)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const faq = await crearFAQ(business._id, actor, datosValidos());

      await expect(obtenerFAQ(otroBusiness._id, faq._id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(obtenerFAQ(business._id, faq._id)).resolves.toMatchObject({ category: 'payments' });
    });
  });

  describe('listarFAQs', () => {
    test('pagina y filtra por categoría', async () => {
      await crearFAQ(business._id, actor, datosValidos({ question: '¿Pregunta A?', category: 'payments' }));
      await crearFAQ(business._id, actor, datosValidos({ question: '¿Pregunta B?', category: 'payments' }));
      await crearFAQ(business._id, actor, datosValidos({ question: '¿Pregunta C?', category: 'delivery' }));

      const { faqs, total } = await listarFAQs(business._id, { category: 'payments' });
      expect(total).toBe(2);
      expect(faqs).toHaveLength(2);
    });

    test('no trae FAQs de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await crearFAQ(business._id, actor, datosValidos({ question: '¿Pregunta A?' }));
      await crearFAQ(otroBusiness._id, actor, datosValidos({ question: '¿Pregunta B?' }));

      const { total } = await listarFAQs(business._id, {});
      expect(total).toBe(1);
    });
  });

  describe('actualizarFAQ', () => {
    test('incrementa version al tocar answer', async () => {
      const faq = await crearFAQ(business._id, actor, datosValidos());
      const actualizada = await actualizarFAQ(business._id, faq._id, actor, { answer: 'Respuesta nueva' });
      expect(actualizada.version).toBe(2);
    });

    test('NO incrementa version al tocar solo tags', async () => {
      const faq = await crearFAQ(business._id, actor, datosValidos());
      const actualizada = await actualizarFAQ(business._id, faq._id, actor, { tags: ['nuevo'] });
      expect(actualizada.version).toBe(1);
    });

    // Bloque 3 (§53, 20/sep/2026) — retrieval semántico, capa adicional.
    describe('embedding', () => {
      test('crearFAQ() genera el embedding con el texto real (question/answer)', async () => {
        const faq = await crearFAQ(business._id, actor, datosValidos());

        expect(faq.embedding).toEqual([0.1, 0.2, 0.3]);
        expect(generarEmbedding).toHaveBeenCalledWith(expect.stringContaining('¿Aceptan Yape?'));
        expect(generarEmbedding).toHaveBeenCalledWith(expect.stringContaining('Sí, aceptamos Yape y Plin.'));
      });

      test('actualizarFAQ() REGENERA el embedding cuando cambia contenido relevante (answer)', async () => {
        const faq = await crearFAQ(business._id, actor, datosValidos());
        generarEmbedding.mockClear();
        generarEmbedding.mockResolvedValueOnce([0.7, 0.7, 0.7]);

        const actualizada = await actualizarFAQ(business._id, faq._id, actor, { answer: 'Respuesta nueva' });

        expect(generarEmbedding).toHaveBeenCalledWith(expect.stringContaining('Respuesta nueva'));
        expect(actualizada.embedding).toEqual([0.7, 0.7, 0.7]);
      });

      test('actualizarFAQ() NO regenera el embedding en un cambio puramente de metadata (tags)', async () => {
        const faq = await crearFAQ(business._id, actor, datosValidos());
        generarEmbedding.mockClear();

        await actualizarFAQ(business._id, faq._id, actor, { tags: ['nuevo'] });

        expect(generarEmbedding).not.toHaveBeenCalled();
      });

      test('si OpenAI falla al crear: la FAQ se guarda igual, embedding queda null (fail-soft)', async () => {
        generarEmbedding.mockRejectedValueOnce(new Error('OpenAI caído'));

        const faq = await crearFAQ(business._id, actor, datosValidos());

        expect(faq.embedding).toBeNull();
        expect(faq.answer).toBe('Sí, aceptamos Yape y Plin.');
      });
    });

    test('recalcula normalizedQuestion al cambiar question', async () => {
      const faq = await crearFAQ(business._id, actor, datosValidos({ question: '¿Aceptan Yape?' }));
      const actualizada = await actualizarFAQ(business._id, faq._id, actor, { question: '¿Dónde están ubicados?' });
      expect(actualizada.normalizedQuestion).toBe('donde estan ubicados');
    });

    test('no puede editar una FAQ de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const faq = await crearFAQ(otroBusiness._id, actor, datosValidos());

      await expect(actualizarFAQ(business._id, faq._id, actor, { answer: 'x' }))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('archivarFAQ', () => {
    test('pone status:"archived", nunca borra el documento', async () => {
      const faq = await crearFAQ(business._id, actor, datosValidos());
      await archivarFAQ(business._id, faq._id, actor);

      const enDb = await FAQ.findById(faq._id);
      expect(enDb).not.toBeNull();
      expect(enDb.status).toBe('archived');
    });
  });
});
