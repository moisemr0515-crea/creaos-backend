// FASE 3 / ETAPA C — respaldo directo del PDF informativo (sin Atlas ni embeddings).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');
const { obtenerRespaldoDocumento, rankearPorPalabras, palabrasClave, MAX_TEXTO_RESPALDO } = require('./documentFallback.service');

describe('documentFallback — funciones puras', () => {
  const chunks = [
    { text: 'La granola artesanal lleva avena y miel.', page: 2 },
    { text: 'Hacemos envíos a todo el país.', page: 1 },
    { text: 'Contacto: ventas@ejemplo.test', page: 3 },
  ];

  test('palabrasClave ignora tildes, mayúsculas, palabras vacías y cortas', () => {
    expect(palabrasClave('¿Qué GRANOLA tienen para el envío?')).toEqual(['granola', 'envio']);
    expect(palabrasClave('   ')).toEqual([]);
  });

  test('rankearPorPalabras ordena por coincidencias y descarta lo que no coincide', () => {
    expect(rankearPorPalabras(chunks, 'granola con miel')).toEqual([{ text: chunks[0].text, page: 2 }]);
    expect(rankearPorPalabras(chunks, 'envios pais granola').map((c) => c.page)).toEqual([1, 2]); // 2 coincidencias antes que 1
    expect(rankearPorPalabras(chunks, 'zapatillas')).toEqual([]);
    expect(rankearPorPalabras(chunks, '')).toEqual([]);
  });
});

describe('documentFallback — obtenerRespaldoDocumento (Mongo real)', () => {
  let business;
  beforeAll(async () => mongoose.connect('mongodb://localhost:27017/creaos_test_document_fallback'));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Promise.all([Business.deleteMany({}), BusinessDocumentChunk.deleteMany({})]);
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const chunk = (biz, text, extra = {}) => BusinessDocumentChunk.create({
    business: biz._id, documentId: new mongoose.Types.ObjectId(), documentVersion: 1, chunkIndex: 0, text, page: 1,
    embedding: new Array(1536).fill(0.01), active: true, ...extra,
  });

  test('sin negocio, sin chunks y sin texto ⇒ null (nunca lanza)', async () => {
    expect(await obtenerRespaldoDocumento(null, 'x')).toBeNull();
    expect(await obtenerRespaldoDocumento(business, 'granola')).toBeNull();
  });

  test('devuelve los chunks activos que coinciden con la consulta y el texto extraído', async () => {
    await chunk(business, 'La granola artesanal lleva avena y miel.');
    await chunk(business, 'Hacemos envíos a todo el país.', { chunkIndex: 1 });
    await Business.updateOne({ _id: business._id }, { $set: { pdfExtractedText: 'Texto completo del PDF.' } });
    const r = await obtenerRespaldoDocumento(await Business.findById(business._id), 'granola');
    expect(r).toMatchObject({ available: true, source: 'pdf_informativo', text: 'Texto completo del PDF.' });
    expect(r.chunks).toEqual([{ text: 'La granola artesanal lleva avena y miel.', page: 1 }]);
    expect(r.note).toMatch(/no es un archivo que se envía/);
  });

  test('solo texto extraído (sin chunks) ⇒ lo devuelve recortado al máximo', async () => {
    await Business.updateOne({ _id: business._id }, { $set: { pdfSummary: 'a'.repeat(900) } });
    const r = await obtenerRespaldoDocumento(await Business.findById(business._id), 'cualquier cosa');
    expect(r.chunks).toBeUndefined();
    expect(r.text.length).toBeLessThanOrEqual(MAX_TEXTO_RESPALDO);
  });

  test('aislamiento: nunca usa chunks de otro negocio ni chunks inactivos', async () => {
    const otro = await Business.create({ name: 'Otro' });
    await chunk(otro, 'La granola del otro negocio.');
    await chunk(business, 'La granola inactiva.', { active: false });
    expect(await obtenerRespaldoDocumento(business, 'granola')).toBeNull();
  });
});
