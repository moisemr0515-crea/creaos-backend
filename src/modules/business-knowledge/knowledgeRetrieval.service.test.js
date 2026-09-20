// Test real (Jest, Mongo real) de knowledgeRetrieval.service.js — CREA
// SALES AI™ C.2, Etapa 3/11. Este es el archivo con el riesgo técnico más
// alto de la Etapa (documento §11.2/§4.1: los hard filters de
// tenant+status+vigencia NUNCA deben depender del prompt) — en particular
// se verifica empíricamente que Mongo tolera `$text` como sibling de
// `$and`+`$or` en el mismo objeto de query (riesgo identificado en el
// audit, sin verificar hasta este archivo).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('../products/product.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const Policy = require('./policy.model');
const FAQ = require('./faq.model');

// Bloque 3 (§53, 20/sep/2026) — buscarConocimiento() con `texto` ahora
// pide un embedding de la query para la mitad semántica del retrieval.
// Se mockea a null acá (Mongo local no soporta $vectorSearch de todas
// formas, ver comentario del archivo de arriba) — este suite se queda
// enfocado en su contrato de siempre: los hard filters textuales. El
// retrieval semántico en sí tiene su propio test dedicado.
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue(null) }));

const { buscarConocimiento } = require('./knowledgeRetrieval.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_knowledge_retrieval';

describe('knowledgeRetrieval.service#buscarConocimiento', () => {
  let business;
  let otroBusiness;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    otroBusiness = await Business.create({ name: 'Otro negocio' });
  });

  const crearPolicyActiva = (biz, overrides = {}) =>
    Policy.create({
      business: biz._id,
      code: overrides.code || `POL-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      title: 'Policy activa',
      category: 'returns',
      policyType: 'rule',
      statement: 'Se aceptan cambios hasta 7 días después de la compra.',
      status: 'active',
      scope: { appliesToAll: true },
      ...overrides,
    });

  const crearFAQActiva = (biz, overrides = {}) =>
    FAQ.create({
      business: biz._id,
      question: overrides.question || '¿Aceptan Yape?',
      answer: 'Sí, aceptamos Yape.',
      category: 'payments',
      status: 'active',
      scope: { appliesToAll: true },
      ...overrides,
    });

  describe('aislamiento por tenant', () => {
    test('nunca trae Policies/FAQs de otro negocio', async () => {
      await crearPolicyActiva(otroBusiness);
      await crearFAQActiva(otroBusiness);

      const { policies, faqs } = await buscarConocimiento(business._id);
      expect(policies).toHaveLength(0);
      expect(faqs).toHaveLength(0);
    });
  });

  describe('hard filter de status', () => {
    test('excluye Policies/FAQs en draft o archived', async () => {
      await crearPolicyActiva(business, { code: 'DRAFT', status: 'draft' });
      await crearPolicyActiva(business, { code: 'ARCH', status: 'archived' });
      const activa = await crearPolicyActiva(business, { code: 'ACTIVE' });

      await crearFAQActiva(business, { question: 'draft?', status: 'draft' });
      const faqActiva = await crearFAQActiva(business, { question: 'active?' });

      const { policies, faqs } = await buscarConocimiento(business._id);
      expect(policies.map((p) => p._id.toString())).toEqual([activa._id.toString()]);
      expect(faqs.map((f) => f._id.toString())).toEqual([faqActiva._id.toString()]);
    });
  });

  describe('hard filter de vigencia', () => {
    test('excluye una Policy cuya vigencia todavía no empezó (effectiveFrom futuro)', async () => {
      const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await crearPolicyActiva(business, { effectiveFrom: manana });

      const { policies } = await buscarConocimiento(business._id);
      expect(policies).toHaveLength(0);
    });

    test('excluye una Policy cuya vigencia ya venció (effectiveUntil pasado)', async () => {
      const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await crearPolicyActiva(business, { effectiveUntil: ayer });

      const { policies } = await buscarConocimiento(business._id);
      expect(policies).toHaveLength(0);
    });

    test('incluye una Policy vigente ahora (effectiveFrom pasado, effectiveUntil futuro)', async () => {
      const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const manana = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await crearPolicyActiva(business, { effectiveFrom: ayer, effectiveUntil: manana });

      const { policies } = await buscarConocimiento(business._id);
      expect(policies).toHaveLength(1);
    });

    test('incluye una Policy sin effectiveFrom/effectiveUntil (null = sin restricción)', async () => {
      await crearPolicyActiva(business);
      const { policies } = await buscarConocimiento(business._id);
      expect(policies).toHaveLength(1);
    });
  });

  describe('scope', () => {
    test('appliesToAll:true siempre matchea, sin importar productIds/channelId del contexto', async () => {
      await crearPolicyActiva(business, { scope: { appliesToAll: true } });
      const { policies } = await buscarConocimiento(business._id, null, { productIds: ['000000000000000000000000'] });
      expect(policies).toHaveLength(1);
    });

    test('Policy con scope específico solo matchea si productIds del contexto intersecta', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      const otroProducto = await Product.create({ business: business._id, sku: 'B', name: 'B' });
      await crearPolicyActiva(business, { scope: { appliesToAll: false, productIds: [producto._id] } });

      const sinMatch = await buscarConocimiento(business._id, null, { productIds: [otroProducto._id.toString()] });
      expect(sinMatch.policies).toHaveLength(0);

      const conMatch = await buscarConocimiento(business._id, null, { productIds: [producto._id.toString()] });
      expect(conMatch.policies).toHaveLength(1);
    });

    test('Policy con scope específico por channelId', async () => {
      const canal = await WhatsAppChannel.create({
        tenantId: business._id,
        businessId: business._id,
        phoneNumber: '+51900000000',
        phoneNumberId: 'phone-id-1',
        connectionType: 'PLATFORM',
      });
      await crearPolicyActiva(business, { scope: { appliesToAll: false, channelIds: [canal._id] } });

      const sinMatch = await buscarConocimiento(business._id, null, { channelId: new mongoose.Types.ObjectId().toString() });
      expect(sinMatch.policies).toHaveLength(0);

      const conMatch = await buscarConocimiento(business._id, null, { channelId: canal._id.toString() });
      expect(conMatch.policies).toHaveLength(1);
    });

    test('FAQ.scope V1 no tiene productIds — productIds del contexto no afecta el match de FAQs', async () => {
      await crearFAQActiva(business, { scope: { appliesToAll: true } });
      const { faqs } = await buscarConocimiento(business._id, null, { productIds: ['000000000000000000000000'] });
      expect(faqs).toHaveLength(1);
    });
  });

  describe('búsqueda de texto ($text + $and + $or en el mismo query — riesgo técnico verificado acá)', () => {
    test('no lanza el error de planner de Mongo al combinar $text con $and/$or como siblings', async () => {
      await crearPolicyActiva(business, { statement: 'Aceptamos devoluciones dentro de 7 días' });
      await crearFAQActiva(business, { question: '¿Cómo hago una devolución?', answer: 'Contactanos por WhatsApp' });

      await expect(buscarConocimiento(business._id, 'devolución')).resolves.toBeDefined();
    });

    // Nota: el índice de texto de Mongo (sin collation diacritic-insensitive
    // explícita) es sensible a tildes — "devolución" y "devolucion" NO
    // matchean entre sí. Es comportamiento real de Mongo, no un bug de
    // buscarConocimiento(); por eso el texto de búsqueda en estos tests usa
    // la misma tilde que el contenido almacenado. La normalización
    // diacrítica ya existe a nivel de aplicación para FAQ
    // (normalizarPregunta() en faq.model.js) precisamente porque no se
    // puede confiar en que $text la resuelva — mejorar el matching de texto
    // libre (fuzzy/diacritic-insensitive) queda fuera de esta Etapa
    // ("sin ranking todavía"), no es parte del hard-filter que se valida acá.
    test('el texto de búsqueda filtra resultados relevantes (Policy)', async () => {
      await crearPolicyActiva(business, { code: 'REL', statement: 'Aceptamos devoluciones dentro de 7 días' });
      await crearPolicyActiva(business, { code: 'IRREL', statement: 'Los pagos se procesan en 24 horas' });

      const { policies } = await buscarConocimiento(business._id, 'devolución');
      expect(policies.map((p) => p.code)).toEqual(['REL']);
    });

    test('el texto de búsqueda filtra resultados relevantes (FAQ)', async () => {
      await crearFAQActiva(business, { question: '¿Cómo hago una devolución?' });
      await crearFAQActiva(business, { question: '¿Qué medios de pago aceptan?' });

      const { faqs } = await buscarConocimiento(business._id, 'devolución');
      expect(faqs).toHaveLength(1);
      expect(faqs[0].question).toBe('¿Cómo hago una devolución?');
    });

    test('sigue respetando hard filters de status/vigencia aun con búsqueda de texto activa', async () => {
      await crearPolicyActiva(business, { statement: 'Aceptamos devoluciones', status: 'draft' });

      const { policies } = await buscarConocimiento(business._id, 'devolución');
      expect(policies).toHaveLength(0);
    });

    test('sin texto, ordena por priority descendente', async () => {
      await crearPolicyActiva(business, { code: 'LOW', priority: 10 });
      await crearPolicyActiva(business, { code: 'HIGH', priority: 90 });

      const { policies } = await buscarConocimiento(business._id);
      expect(policies.map((p) => p.code)).toEqual(['HIGH', 'LOW']);
    });
  });
});
