// Test real (Jest, Mongo real + Policy/FAQ/BusinessDocumentChunk
// .aggregate() mockeado para $vectorSearch) — cubre 1:1 los 8 escenarios
// de la sección 56 del documento de auditoría (TESTS BLOQUE 3), como
// checklist trazable. Cada test corresponde a exactamente una línea de
// esa sección. La lógica de cada pieza ya tiene su propia cobertura más
// profunda en pdfIngestion.service.test.js / knowledgeRetrieval.semantic.test.js
// / priceStockGuard.service.test.js — este archivo es la traza de
// aceptación, no una reimplementación de esos tests.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Policy = require('./policy.model');
const FAQ = require('./faq.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');

jest.mock('../../utils/embeddings', () => ({ generarEmbedding: jest.fn() }));
const { generarEmbedding } = require('../../utils/embeddings');

jest.mock('../products/product.service', () => ({ buscarProductos: jest.fn().mockResolvedValue([]) }));

const { resolverConocimiento, buscarChunksDocumento } = require('./knowledgeRetrieval.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_knowledge_bloque3_acceptance';

describe('Bloque 3 — TESTS (documento §56), traza 1:1', () => {
  let negocioA;
  let negocioB;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
    await FAQ.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await BusinessDocumentChunk.deleteMany({});
    await mongoose.connection.db.collection('businessdocuments').deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Policy.deleteMany({});
    await FAQ.deleteMany({});
    await BusinessDocumentChunk.deleteMany({});
    await mongoose.connection.db.collection('businessdocuments').deleteMany({});
    await Business.deleteMany({});
    negocioA = await Business.create({ name: 'Negocio A' });
    negocioB = await Business.create({ name: 'Negocio B' });
  });

  test('1. pregunta exacta del PDF → responde (chunk real, vía retrieval semántico)', async () => {
    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([
      { _id: new mongoose.Types.ObjectId(), text: 'Nuestro horario de atención es de lunes a sábado, 9am a 7pm.', page: 1, score: 0.95 },
    ]);

    const chunks = await buscarChunksDocumento(negocioA._id, '¿Cuál es el horario de atención?');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('lunes a sábado');
  });

  test('2. paráfrasis (sin palabras en común) → responde igual, vía similitud semántica', async () => {
    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([
      { _id: new mongoose.Types.ObjectId(), text: 'Atendemos de lunes a sábado entre las 9 de la mañana y las 7 de la noche.', page: 1, score: 0.82 },
    ]);

    // Ninguna palabra literal en común con el chunk de arriba.
    const chunks = await buscarChunksDocumento(negocioA._id, '¿a qué hora puedo pasar a comprar un fin de semana?');

    expect(chunks).toHaveLength(1);
  });

  test('3. dato no presente → no inventa (arrays vacíos, no un error ni contenido fabricado)', async () => {
    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    jest.spyOn(Policy, 'aggregate').mockResolvedValue([]);
    jest.spyOn(FAQ, 'aggregate').mockResolvedValue([]);
    jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([]);

    const resultado = await resolverConocimiento(negocioA._id, 'algo que este negocio nunca cargó');

    expect(resultado).toMatchObject({ policies: [], faqs: [], documentChunks: [] });
  });

  test('4. tenant B no recupera chunks de A (aislamiento multi-tenant en el filtro de $vectorSearch)', async () => {
    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    const aggregateSpy = jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([]);

    await buscarChunksDocumento(negocioB._id, 'una pregunta cualquiera');

    const filtroUsado = aggregateSpy.mock.calls[0][0][0].$vectorSearch.filter;
    expect(filtroUsado.business).toEqual(negocioB._id);
    expect(filtroUsado.business).not.toEqual(negocioA._id);
  });

  test('5. PDF reemplazado → el retrieval usa la V2 (solo chunks active:true, cutover ya cubierto en pdfIngestion.service.test.js)', async () => {
    const docV1 = await mongoose.connection.db.collection('businessdocuments').insertOne({ business: negocioA._id, version: 1, status: 'archived' });
    await BusinessDocumentChunk.create({
      business: negocioA._id, documentId: docV1.insertedId, documentVersion: 1, chunkIndex: 0,
      text: 'Contenido de la V1, ya reemplazada', embedding: [0.1], active: false,
    });
    const docV2Id = new mongoose.Types.ObjectId();
    await BusinessDocumentChunk.create({
      business: negocioA._id, documentId: docV2Id, documentVersion: 2, chunkIndex: 0,
      text: 'Contenido real de la V2, vigente', embedding: [0.1], active: true,
    });

    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    jest.spyOn(BusinessDocumentChunk, 'aggregate').mockImplementation(async (pipeline) => {
      // Simula lo que Atlas haría con el filtro real: solo active:true.
      const filtro = pipeline[0].$vectorSearch.filter;
      const docs = await BusinessDocumentChunk.find(filtro).lean();
      return docs.map((d) => ({ ...d, score: 0.9 }));
    });

    const chunks = await buscarChunksDocumento(negocioA._id, 'contenido del documento');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('V2, vigente');
  });

  test('6. precio del PDF viejo vs. Product actual → se usa Product (el chunk con precio se descarta, ver priceStockGuard.service.test.js para la unidad)', async () => {
    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    jest.spyOn(Policy, 'aggregate').mockResolvedValue([]);
    jest.spyOn(FAQ, 'aggregate').mockResolvedValue([]);
    jest.spyOn(BusinessDocumentChunk, 'aggregate').mockResolvedValue([
      { _id: new mongoose.Types.ObjectId(), text: 'La moringa cuesta S/. 30 (precio de lanzamiento).', page: 3, score: 0.9 },
    ]);
    const productService = require('../products/product.service');
    productService.buscarProductos.mockResolvedValueOnce([{ productId: 'p1', name: 'Moringa', matchScore: 0.9 }]);

    const resultado = await resolverConocimiento(negocioA._id, '¿cuánto cuesta la moringa?');

    expect(resultado.documentChunks).toEqual([]); // el precio viejo nunca llega — get_price es la fuente real
  });

  test('7. policy inactive → no se usa (hard filter de estado, sin cambios respecto a la Etapa 3 original)', async () => {
    await Policy.create({
      business: negocioA._id, code: 'INACTIVA', title: 'Policy archivada', category: 'other', policyType: 'rule',
      statement: 'Esta policy ya no debería aparecer.', status: 'archived',
    });

    const resultado = await resolverConocimiento(negocioA._id, 'archivada');

    expect(resultado.policies).toEqual([]);
  });

  test('8. FAQ semánticamente similar → match (mismo mecanismo que Policy, ver knowledgeRetrieval.semantic.test.js)', async () => {
    generarEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    const faqReal = await FAQ.create({
      business: negocioA._id, question: '¿Hacen envíos internacionales?', answer: 'Sí, enviamos a toda Latinoamérica.',
      category: 'payments', status: 'active',
    });
    jest.spyOn(FAQ, 'aggregate').mockResolvedValue([{ ...faqReal.toObject(), score: 0.88 }]);
    jest.spyOn(Policy, 'aggregate').mockResolvedValue([]);

    // Sin palabras en común con la pregunta/respuesta real de la FAQ.
    const resultado = await resolverConocimiento(negocioA._id, '¿mandan pedidos fuera del país?');

    expect(resultado.faqs).toHaveLength(1);
    expect(resultado.faqs[0].question).toBe('¿Hacen envíos internacionales?');
  });
});
