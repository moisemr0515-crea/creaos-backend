// Test real (Jest, Mongo real) de policy.service.js — CREA SALES AI™ C.2,
// Etapa 3/11. Cubre el CRUD de administración: validación de referencias
// cruzadas (scope.productIds/channelIds deben pertenecer al mismo
// negocio), aislamiento multi-tenant, incremento de version solo ante
// cambios de contenido relevante, y que archivar nunca borra.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('../products/product.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const Policy = require('./policy.model');

// Bloque 3 (§53, 20/sep/2026) — crearPolicy/actualizarPolicy ahora piden
// un embedding real a OpenAI (fail-soft si falla) — se mockea acá para no
// pegarle a la red en cada test; su propia generación tiene test dedicado
// más abajo.
jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]) }));
const { generarEmbedding } = require('../../utils/embeddings');

const {
  crearPolicy,
  obtenerPolicy,
  listarPolicies,
  actualizarPolicy,
  archivarPolicy,
} = require('./policy.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_policy_service';
const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('policy.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Policy.deleteMany({});
    await Product.deleteMany({});
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
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
    code: 'RETURNS-001',
    title: 'Cambios de productos estándar',
    category: 'exchanges',
    policyType: 'rule',
    statement: 'Se aceptan cambios hasta 7 días después de la compra.',
    ...overrides,
  });

  describe('crearPolicy', () => {
    test('crea una Policy scoped al negocio', async () => {
      const policy = await crearPolicy(business._id, actor, datosValidos());
      expect(policy.business.toString()).toBe(business._id.toString());
      expect(policy.createdBy.toString()).toBe(actor._id.toString());
    });

    test('rechaza un code duplicado en el mismo negocio con 409', async () => {
      await crearPolicy(business._id, actor, datosValidos());
      await expect(crearPolicy(business._id, actor, datosValidos({ title: 'Otra' })))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    test('permite el mismo code en 2 negocios distintos', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await crearPolicy(business._id, actor, datosValidos());
      const enOtro = await crearPolicy(otroBusiness._id, actor, datosValidos());
      expect(enOtro.code).toBe('RETURNS-001');
    });

    test('rechaza scope.productIds que no pertenecen a este negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const productoAjeno = await Product.create({ business: otroBusiness._id, sku: 'A', name: 'A' });

      await expect(crearPolicy(business._id, actor, datosValidos({
        scope: { appliesToAll: false, productIds: [productoAjeno._id] },
      }))).rejects.toMatchObject({ statusCode: 400 });
    });

    test('acepta scope.productIds que sí pertenecen a este negocio', async () => {
      const producto = await Product.create({ business: business._id, sku: 'A', name: 'A' });
      const policy = await crearPolicy(business._id, actor, datosValidos({
        scope: { appliesToAll: false, productIds: [producto._id] },
      }));
      expect(policy.scope.productIds).toHaveLength(1);
    });

    test('rechaza scope.channelIds que no pertenecen a este negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const canalAjeno = await crearCanal(otroBusiness);

      await expect(crearPolicy(business._id, actor, datosValidos({
        scope: { appliesToAll: false, channelIds: [canalAjeno._id] },
      }))).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('obtenerPolicy', () => {
    test('no encuentra una Policy de OTRO negocio (aislamiento por tenant)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const policy = await crearPolicy(business._id, actor, datosValidos());

      await expect(obtenerPolicy(otroBusiness._id, policy._id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(obtenerPolicy(business._id, policy._id)).resolves.toMatchObject({ code: 'RETURNS-001' });
    });

    test('encuentra una Policy en cualquier estado (vista de administración)', async () => {
      const policy = await crearPolicy(business._id, actor, datosValidos());
      await archivarPolicy(business._id, policy._id, actor);

      const encontrada = await obtenerPolicy(business._id, policy._id);
      expect(encontrada.status).toBe('archived');
    });
  });

  describe('listarPolicies', () => {
    test('pagina y filtra por categoría/estado', async () => {
      await crearPolicy(business._id, actor, datosValidos({ code: 'A', category: 'returns' }));
      await crearPolicy(business._id, actor, datosValidos({ code: 'B', category: 'returns' }));
      await crearPolicy(business._id, actor, datosValidos({ code: 'C', category: 'payments' }));

      const { policies, total } = await listarPolicies(business._id, { category: 'returns' });
      expect(total).toBe(2);
      expect(policies.map((p) => p.code).sort()).toEqual(['A', 'B']);
    });

    test('no trae Policies de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await crearPolicy(business._id, actor, datosValidos({ code: 'A' }));
      await crearPolicy(otroBusiness._id, actor, datosValidos({ code: 'B' }));

      const { total } = await listarPolicies(business._id, {});
      expect(total).toBe(1);
    });
  });

  describe('actualizarPolicy', () => {
    test('incrementa version al tocar un campo de contenido relevante (statement)', async () => {
      const policy = await crearPolicy(business._id, actor, datosValidos());
      const actualizada = await actualizarPolicy(business._id, policy._id, actor, { statement: 'Texto nuevo' });
      expect(actualizada.version).toBe(2);
      expect(actualizada.updatedBy.toString()).toBe(actor._id.toString());
    });

    test('NO incrementa version al tocar solo metadata (tags)', async () => {
      const policy = await crearPolicy(business._id, actor, datosValidos());
      const actualizada = await actualizarPolicy(business._id, policy._id, actor, { tags: ['nuevo-tag'] });
      expect(actualizada.version).toBe(1);
    });

    // Bloque 3 (§53, 20/sep/2026) — retrieval semántico, capa adicional.
    describe('embedding', () => {
      test('crearPolicy() genera el embedding con el texto real (title/statement)', async () => {
        const policy = await crearPolicy(business._id, actor, datosValidos());

        expect(policy.embedding).toEqual([0.1, 0.2, 0.3]);
        expect(generarEmbedding).toHaveBeenCalledWith(expect.stringContaining('Cambios de productos estándar'));
        expect(generarEmbedding).toHaveBeenCalledWith(expect.stringContaining('Se aceptan cambios hasta 7 días'));
      });

      test('actualizarPolicy() REGENERA el embedding cuando cambia contenido relevante (statement)', async () => {
        const policy = await crearPolicy(business._id, actor, datosValidos());
        generarEmbedding.mockClear();
        generarEmbedding.mockResolvedValueOnce([0.9, 0.9, 0.9]);

        const actualizada = await actualizarPolicy(business._id, policy._id, actor, { statement: 'Texto totalmente nuevo' });

        expect(generarEmbedding).toHaveBeenCalledWith(expect.stringContaining('Texto totalmente nuevo'));
        expect(actualizada.embedding).toEqual([0.9, 0.9, 0.9]);
      });

      test('actualizarPolicy() NO regenera el embedding en un cambio puramente de metadata (tags)', async () => {
        const policy = await crearPolicy(business._id, actor, datosValidos());
        generarEmbedding.mockClear();

        await actualizarPolicy(business._id, policy._id, actor, { tags: ['nuevo-tag'] });

        expect(generarEmbedding).not.toHaveBeenCalled();
      });

      test('si OpenAI falla al crear: la Policy se guarda igual, embedding queda null (fail-soft)', async () => {
        generarEmbedding.mockRejectedValueOnce(new Error('OpenAI caído'));

        const policy = await crearPolicy(business._id, actor, datosValidos());

        expect(policy.embedding).toBeNull();
        expect(policy.statement).toBe('Se aceptan cambios hasta 7 días después de la compra.'); // se guardó igual
      });
    });

    test('valida code duplicado al cambiarlo', async () => {
      await crearPolicy(business._id, actor, datosValidos({ code: 'A' }));
      const b = await crearPolicy(business._id, actor, datosValidos({ code: 'B' }));

      await expect(actualizarPolicy(business._id, b._id, actor, { code: 'A' }))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    test('no puede editar una Policy de otro negocio', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const policy = await crearPolicy(otroBusiness._id, actor, datosValidos());

      await expect(actualizarPolicy(business._id, policy._id, actor, { statement: 'x' }))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('archivarPolicy', () => {
    test('pone status:"archived", nunca borra el documento', async () => {
      const policy = await crearPolicy(business._id, actor, datosValidos());
      await archivarPolicy(business._id, policy._id, actor);

      const enDb = await Policy.findById(policy._id);
      expect(enDb).not.toBeNull();
      expect(enDb.status).toBe('archived');
    });
  });
});
