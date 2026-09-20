// Test real (Jest, Mongo real para $text + Policy/FAQ/BusinessDocumentChunk
// .aggregate() mockeado para $vectorSearch — Atlas Vector Search no está
// disponible en un Mongo standalone local, confirmado en la Fase 1 de este
// bloque) de la mitad SEMÁNTICA de knowledgeRetrieval.service.js — Bloque
// 3 de la auditoría Business Brain (§51/§53, 20/sep/2026). El matching
// textual ya tiene su propio suite (knowledgeRetrieval.service.test.js);
// este archivo cubre lo que se sumó: combinación texto+semántica sin
// duplicar, el piso de similitud, el fail-soft si el índice todavía no
// está listo, y el retrieval de chunks del PDF.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Policy = require('./policy.model');
const FAQ = require('./faq.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');

jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn() }));
const { generarEmbedding } = require('../../utils/embeddings');

// Fase 2, punto 5 (§52/§54, 20/sep/2026) — resolverConocimiento() ahora
// pasa documentChunks por la barrera de descarte de precio/stock — se
// mockea acá (su propia lógica ya tiene test dedicado en
// priceStockGuard.service.test.js), este archivo solo confirma que la
// integración real ocurre.
jest.mock('../products/product.service', () => ({ buscarProductos: jest.fn() }));
const productService = require('../products/product.service');

const { buscarConocimiento, buscarChunksDocumento, resolverConocimiento } = require('./knowledgeRetrieval.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_knowledge_retrieval_semantic';

describe('knowledgeRetrieval.service — retrieval semántico (Bloque 3, §51/§53)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await BusinessDocumentChunk.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await BusinessDocumentChunk.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buscarConocimiento() — combinación texto + semántica', () => {
    test('sin embedding disponible (generarEmbedding devuelve null): se comporta EXACTO igual que antes de este bloque, solo texto', async () => {
      generarEmbedding.mockResolvedValue(null);
      const aggregateSpy = jest.spyOn(Policy, 'aggregate');
      await Policy.create({
        business: business._id, code: 'A', title: 'Devoluciones', category: 'returns', policyType: 'rule',
        statement: 'Se aceptan devoluciones hasta 7 días.', status: 'active',
      });

      const { policies } = await buscarConocimiento(business._id, 'devoluciones');

      expect(policies).toHaveLength(1);
      expect(aggregateSpy).not.toHaveBeenCalled(); // buscarSemantico corta antes de intentar $vectorSearch
    });

    test('un candidato encontrado SOLO por semántica (no matchea $text) se suma igual, sin duplicar el que sí matchea por texto', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      const porTexto = await Policy.create({
        business: business._id, code: 'TEXTO', title: 'Envíos', category: 'shipping_delivery', policyType: 'rule',
        statement: 'Hacemos envíos a todo el país.', status: 'active',
      });
      const porSemantica = await Policy.create({
        business: business._id, code: 'SEMANTICA', title: 'Tiempos de entrega', category: 'shipping_delivery', policyType: 'rule',
        statement: 'Tu pedido puede demorar entre 3 y 5 días hábiles en llegar.', status: 'active',
      });

      jest.spyOn(Policy, 'aggregate').mockResolvedValue([
        { ...porSemantica.toObject(), score: 0.9 },
      ]);

      const { policies } = await buscarConocimiento(business._id, 'envíos');

      const codes = policies.map((p) => p.code).sort();
      expect(codes).toEqual(['SEMANTICA', 'TEXTO']);
    });

    test('un candidato que matchea AMBOS (texto y semántica) aparece una sola vez', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      const policy = await Policy.create({
        business: business._id, code: 'AMBOS', title: 'Envíos', category: 'shipping_delivery', policyType: 'rule',
        statement: 'Hacemos envíos a todo el país en 3 a 5 días.', status: 'active',
      });
      jest.spyOn(Policy, 'aggregate').mockResolvedValue([{ ...policy.toObject(), score: 0.95 }]);

      const { policies } = await buscarConocimiento(business._id, 'envíos');

      expect(policies).toHaveLength(1);
    });

    test('resultados por debajo del umbral de similitud se descartan (Atlas siempre devuelve K vecinos, sean relevantes o no)', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      const irrelevante = await Policy.create({
        business: business._id, code: 'LEJANO', title: 'Algo sin relación', category: 'other', policyType: 'rule',
        statement: 'Contenido totalmente distinto.', status: 'active',
      });
      jest.spyOn(Policy, 'aggregate').mockResolvedValue([{ ...irrelevante.toObject(), score: 0.2 }]); // debajo de 0.75

      const { policies } = await buscarConocimiento(business._id, 'una query cualquiera que no matchea texto');

      expect(policies).toHaveLength(0);
    });

    test('si $vectorSearch falla (ej. índice todavía PENDING en Atlas): no rompe, sigue devolviendo los resultados de texto', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      await Policy.create({
        business: business._id, code: 'A', title: 'Devoluciones', category: 'returns', policyType: 'rule',
        statement: 'Se aceptan devoluciones hasta 7 días.', status: 'active',
      });
      jest.spyOn(Policy, 'aggregate').mockRejectedValue(new Error('Index not queryable yet'));

      const { policies } = await buscarConocimiento(business._id, 'devoluciones');

      expect(policies).toHaveLength(1); // el resultado de texto sigue intacto
    });

    test('el filtro que recibe $vectorSearch es el ESTRUCTURAL puro (business/status/vigencia/scope) — nunca incluye $text', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      const aggregateSpy = jest.spyOn(Policy, 'aggregate').mockResolvedValue([]);

      await buscarConocimiento(business._id, 'una query');

      const pipeline = aggregateSpy.mock.calls[0][0];
      const filtroUsado = pipeline[0].$vectorSearch.filter;
      expect(filtroUsado.$text).toBeUndefined();
      expect(filtroUsado.business).toEqual(business._id);
      expect(filtroUsado.status).toBe('active');
    });
  });

  describe('buscarChunksDocumento()', () => {
    test('sin texto: array vacío, no genera ningún embedding', async () => {
      const resultado = await buscarChunksDocumento(business._id, '');
      expect(resultado).toEqual([]);
      expect(generarEmbedding).not.toHaveBeenCalled();
    });

    test('sin embedding disponible: array vacío, no intenta $vectorSearch', async () => {
      generarEmbedding.mockResolvedValue(null);
      const aggregateSpy = jest.spyOn(BusinessDocumentChunk, 'aggregate');

      const resultado = await buscarChunksDocumento(business._id, 'una pregunta');

      expect(resultado).toEqual([]);
      expect(aggregateSpy).not.toHaveBeenCalled();
    });

    test('filtra por business + active:true (nunca un $lookup a BusinessDocument)', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      const aggregateSpy = jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([]);

      await buscarChunksDocumento(business._id, 'una pregunta');

      const pipeline = aggregateSpy.mock.calls[0][0];
      expect(pipeline[0].$vectorSearch.filter).toEqual({ business: business._id, active: true });
      expect(pipeline[0].$vectorSearch.index).toBe('chunk_vector_index');
    });

    test('devuelve como máximo K=5 chunks, ya ordenados por similitud', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      const seisResultados = Array.from({ length: 6 }, (_, i) => ({
        _id: new mongoose.Types.ObjectId(), text: `chunk ${i}`, page: i, score: 0.9 - i * 0.01,
      }));
      jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue(seisResultados);

      const resultado = await buscarChunksDocumento(business._id, 'una pregunta');

      expect(resultado).toHaveLength(5);
      expect(resultado[0].text).toBe('chunk 0');
    });
  });

  describe('resolverConocimiento() — incluye documentChunks en el resultado final', () => {
    test('documentChunks viaja con text/page/score, en paralelo a policies/faqs', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      jest.spyOn(Policy, 'aggregate').mockResolvedValue([]);
      jest.spyOn(FAQ, 'aggregate').mockResolvedValue([]);
      jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([
        { _id: new mongoose.Types.ObjectId(), text: 'Fragmento del PDF', page: 2, score: 0.88 },
      ]);

      const resultado = await resolverConocimiento(business._id, 'una pregunta sobre el negocio');

      expect(resultado.documentChunks).toEqual([{ text: 'Fragmento del PDF', page: 2, score: 0.88 }]);
    });

    test('sin texto: documentChunks vacío, no genera ningún embedding', async () => {
      const resultado = await resolverConocimiento(business._id, undefined);
      expect(resultado.documentChunks).toEqual([]);
    });

    // Fase 2, punto 5 (§52/§54, 20/sep/2026) — la barrera de descarte de
    // precio/stock desactualizado corre DE VERDAD dentro de
    // resolverConocimiento(), no es solo una función suelta sin conectar.
    test('un chunk con precio de un producto REAL del catálogo NUNCA llega en documentChunks — se descarta antes de devolver', async () => {
      generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      jest.spyOn(Policy, 'aggregate').mockResolvedValue([]);
      jest.spyOn(FAQ, 'aggregate').mockResolvedValue([]);
      jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([
        { _id: new mongoose.Types.ObjectId(), text: 'La moringa cuesta S/. 45 el frasco.', page: 5, score: 0.9 },
        { _id: new mongoose.Types.ObjectId(), text: 'Somos una empresa con más de 10 años de trayectoria.', page: 1, score: 0.85 },
      ]);
      productService.buscarProductos.mockImplementation(async (bid, texto) =>
        texto.includes('moringa') ? [{ productId: 'p1', name: 'Moringa', matchScore: 0.9 }] : []
      );

      const resultado = await resolverConocimiento(business._id, 'cuánto cuesta la moringa');

      expect(resultado.documentChunks).toEqual([
        { text: 'Somos una empresa con más de 10 años de trayectoria.', page: 1, score: 0.85 },
      ]);
    });
  });
});
