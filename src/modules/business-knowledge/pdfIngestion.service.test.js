// Test real (Jest, Mongo real) de pdfIngestion.service.js — Bloque 3 de la
// auditoría Business Brain (§45-50, 20/sep/2026), el corazón del pipeline
// de RAG del PDF: el cutover transaccional entre generaciones.
//
// Mongo local (standalone) no soporta transacciones — este suite ejercita
// la rama de fallback secuencial (mismo criterio EXACTO que
// auth.service.js#registrar(), que tiene el mismo problema y la misma
// solución: las operaciones son IDÉNTICAS en ambas ramas, solo cambia si
// van envueltas en session.withTransaction() o no — la garantía de
// atomicidad real es de MongoDB en Atlas/replica set, no algo que este
// test pueda reproducir localmente). Lo que SÍ cubre este suite es la
// corrección funcional completa: qué queda escrito, en qué estado, y que
// un fallo nunca toca la generación anterior.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const BusinessDocument = require('./businessDocument.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');

jest.mock('../../utils/embeddings', () => ({ generarEmbeddings: jest.fn() }));
const { generarEmbeddings } = require('../../utils/embeddings');

const { iniciarNuevoDocumento, procesarDocumento } = require('./pdfIngestion.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_pdf_ingestion';

describe('pdfIngestion.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await BusinessDocumentChunk.deleteMany({});
    await BusinessDocument.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await BusinessDocumentChunk.deleteMany({});
    await BusinessDocument.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  describe('iniciarNuevoDocumento()', () => {
    test('primer documento del negocio: version 1, sin documento anterior', async () => {
      const { documento, documentoAnteriorId } = await iniciarNuevoDocumento(business._id, {
        publicId: 'creaos/docs/x/a',
        resourceType: 'raw',
      });

      expect(documento.version).toBe(1);
      expect(documento.status).toBe('uploaded');
      expect(documentoAnteriorId).toBeNull();
    });

    test('segundo documento: version 2, y el documento "ready" anterior pasa a "replacing" sin tocar sus chunks', async () => {
      const anterior = await BusinessDocument.create({
        business: business._id,
        version: 1,
        sourceAsset: { publicId: 'a', resourceType: 'raw' },
        status: 'ready',
      });
      await BusinessDocumentChunk.create({
        business: business._id, documentId: anterior._id, documentVersion: 1, chunkIndex: 0,
        text: 'chunk viejo', embedding: [0.1], active: true,
      });

      const { documento, documentoAnteriorId } = await iniciarNuevoDocumento(business._id, {
        publicId: 'creaos/docs/x/b',
        resourceType: 'raw',
      });

      expect(documento.version).toBe(2);
      expect(String(documentoAnteriorId)).toBe(String(anterior._id));

      const anteriorReleido = await BusinessDocument.findById(anterior._id);
      expect(anteriorReleido.status).toBe('replacing');
      const chunkViejo = await BusinessDocumentChunk.findOne({ documentId: anterior._id });
      expect(chunkViejo.active).toBe(true); // sin tocar todavía
    });
  });

  describe('procesarDocumento() — camino feliz, primera generación (sin documento anterior)', () => {
    test('chunkea, pide embeddings en batch, deja el documento "ready" con sus chunks active:true', async () => {
      const documento = await BusinessDocument.create({
        business: business._id, version: 1, sourceAsset: { publicId: 'a', resourceType: 'raw' }, status: 'uploaded',
      });
      generarEmbeddings.mockResolvedValue([[0.1, 0.2]]);

      const resultado = await procesarDocumento(documento._id, 'Un documento de negocio chico.');

      expect(resultado.chunkCount).toBe(1);
      const documentoFinal = await BusinessDocument.findById(documento._id);
      expect(documentoFinal.status).toBe('ready');
      expect(documentoFinal.chunkCount).toBe(1);
      expect(documentoFinal.readyAt).toBeInstanceOf(Date);

      const chunks = await BusinessDocumentChunk.find({ documentId: documento._id });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].active).toBe(true);
      expect(chunks[0].embedding).toEqual([0.1, 0.2]);
    });

    test('PDF sin texto extraíble (escaneado): 0 chunks, "ready" igual, nunca llama a embeddings', async () => {
      const documento = await BusinessDocument.create({
        business: business._id, version: 1, sourceAsset: { publicId: 'a', resourceType: 'raw' }, status: 'uploaded',
      });

      const resultado = await procesarDocumento(documento._id, '   \n\n  ');

      expect(resultado.chunkCount).toBe(0);
      expect(generarEmbeddings).not.toHaveBeenCalled();
      const documentoFinal = await BusinessDocument.findById(documento._id);
      expect(documentoFinal.status).toBe('ready');
      expect(documentoFinal.chunkCount).toBe(0);
    });
  });

  describe('procesarDocumento() — reemplazo con documento anterior (cutover)', () => {
    let anterior;

    beforeEach(async () => {
      anterior = await BusinessDocument.create({
        business: business._id, version: 1, sourceAsset: { publicId: 'a', resourceType: 'raw' }, status: 'replacing',
      });
      await BusinessDocumentChunk.create([
        { business: business._id, documentId: anterior._id, documentVersion: 1, chunkIndex: 0, text: 'chunk viejo 1', embedding: [0.1], active: true },
        { business: business._id, documentId: anterior._id, documentVersion: 1, chunkIndex: 1, text: 'chunk viejo 2', embedding: [0.2], active: true },
      ]);
    });

    test('éxito: la nueva generación queda "ready" y activa, la anterior queda "archived" con sus chunks inactivos', async () => {
      const nuevo = await BusinessDocument.create({
        business: business._id, version: 2, sourceAsset: { publicId: 'b', resourceType: 'raw' }, status: 'uploaded',
      });
      generarEmbeddings.mockResolvedValue([[0.9, 0.9]]);

      await procesarDocumento(nuevo._id, 'Documento nuevo de reemplazo.');

      const anteriorFinal = await BusinessDocument.findById(anterior._id);
      expect(anteriorFinal.status).toBe('archived');
      const chunksViejos = await BusinessDocumentChunk.find({ documentId: anterior._id });
      expect(chunksViejos.every((c) => c.active === false)).toBe(true);

      const nuevoFinal = await BusinessDocument.findById(nuevo._id);
      expect(nuevoFinal.status).toBe('ready');
      const chunksNuevos = await BusinessDocumentChunk.find({ documentId: nuevo._id });
      expect(chunksNuevos.every((c) => c.active === true)).toBe(true);

      // En ningún momento el negocio se queda sin NINGÚN chunk activo:
      // exactamente los del nuevo documento están activos, ninguno más, ninguno menos.
      const activos = await BusinessDocumentChunk.find({ business: business._id, active: true });
      expect(activos.map((c) => String(c.documentId)).every((id) => id === String(nuevo._id))).toBe(true);
      expect(activos.length).toBeGreaterThan(0);
    });

    test('CRÍTICO — si falla la generación de embeddings: el documento nuevo queda "failed" y el anterior VUELVE a "ready" sin que sus chunks se hayan tocado', async () => {
      const nuevo = await BusinessDocument.create({
        business: business._id, version: 2, sourceAsset: { publicId: 'b', resourceType: 'raw' }, status: 'uploaded',
      });
      generarEmbeddings.mockRejectedValue(new Error('OpenAI rate limit'));

      await expect(procesarDocumento(nuevo._id, 'Documento nuevo de reemplazo.')).rejects.toThrow('OpenAI rate limit');

      const nuevoFinal = await BusinessDocument.findById(nuevo._id);
      expect(nuevoFinal.status).toBe('failed');
      expect(nuevoFinal.error).toBe('OpenAI rate limit');
      expect(await BusinessDocumentChunk.countDocuments({ documentId: nuevo._id })).toBe(0);

      const anteriorFinal = await BusinessDocument.findById(anterior._id);
      expect(anteriorFinal.status).toBe('ready'); // vuelve a ready, no se queda en 'replacing' ni 'archived'
      const chunksViejos = await BusinessDocumentChunk.find({ documentId: anterior._id });
      expect(chunksViejos.every((c) => c.active === true)).toBe(true); // NUNCA se tocaron

      // El negocio nunca se quedó sin chunks activos durante todo el intento fallido.
      const activos = await BusinessDocumentChunk.find({ business: business._id, active: true });
      expect(activos).toHaveLength(2);
    });

    test('el documento nuevo no existe (id inválido): lanza, no revienta silenciosamente', async () => {
      await expect(procesarDocumento(new mongoose.Types.ObjectId(), 'texto')).rejects.toThrow('no encontrado');
    });
  });
});
