// Test real (Jest, Mongo real) de business.service.js#subirPdf() —
// auditoría de contexto del agente (12/sep/2026): un PDF escaneado/de
// imágenes (pdf-parse no hace OCR) devuelve texto vacío o casi vacío.
// Antes de este fix, ese texto vacío se mandaba igual a OpenAI para
// "resumir", y la disculpa del modelo ("no puedo resumir, no me diste
// texto") se guardaba tal cual en pdfSummary — confirmado en producción
// para el negocio CREA OS, inyectándose en cada conversación de venta
// como si fuera información real. Cloudinary y pdf-parse se mockean (sin
// red real); OpenAI se espía sobre el cliente real exportado por el
// propio módulo (mismo criterio que ai.service.js).
const mongoose = require('mongoose');
const Business = require('./business.model');
require('../users/user.model'); // subirPdf() hace populate('createdBy', ...)

jest.mock('../../utils/cloudinary', () => ({
  subirBuffer: jest.fn().mockResolvedValue({
    secure_url: 'https://cloudinary.test/negocio.pdf',
    public_id: 'creaos/businesses/x/pdf/abc',
    resource_type: 'raw',
  }),
  eliminarPorUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockGetText = jest.fn();
const mockDestroy = jest.fn().mockResolvedValue(undefined);
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: mockGetText,
    destroy: mockDestroy,
  })),
}));

// Bloque 3 (§45-50, 20/sep/2026) — RAG del PDF, en paralelo al flujo de
// pdfSummary de siempre (foco de este archivo, sin cambios). Se mockea la
// COLA (nunca debe tocar el Redis real de .env durante un test) —
// pdfIngestion.service.js corre real contra el Mongo local de este suite,
// mismo criterio que el resto: solo se mockea lo que haría I/O externo de
// verdad.
jest.mock('../business-knowledge/queues/indexBusinessDocument.queue');
const { enqueueIndexBusinessDocument } = require('../business-knowledge/queues/indexBusinessDocument.queue');

const { subirPdf, openai } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_service_subirpdf';

describe('business.service#subirPdf() — guard de extracción vacía (BUG 3)', () => {
  let business;
  let createSpy;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
    createSpy = jest.spyOn(openai.chat.completions, 'create');
  });

  const fileFalso = { buffer: Buffer.from('contenido-pdf-falso') };

  test('extracción vacía (PDF escaneado/de imágenes): NO llama a OpenAI, NO guarda pdfSummary/pdfExtractedText, sí guarda pdfUrl', async () => {
    mockGetText.mockResolvedValue({ text: '' });

    const actualizado = await subirPdf(business._id, fileFalso);

    expect(createSpy).not.toHaveBeenCalled();
    expect(actualizado.pdfSummary).toBeNull();
    expect(actualizado.pdfExtractedText).toBeNull();
    expect(actualizado.pdfUrl).toBe('https://cloudinary.test/negocio.pdf');
    expect(actualizado.pdfUploadedAt).toBeInstanceOf(Date);

    const releido = await Business.findById(business._id);
    expect(releido.pdfSummary).toBeNull();
  });

  test('texto por debajo del mínimo (ej. "N/A" o una sola palabra): mismo guard, no genera un resumen degenerado', async () => {
    mockGetText.mockResolvedValue({ text: 'N/A' });

    const actualizado = await subirPdf(business._id, fileFalso);

    expect(createSpy).not.toHaveBeenCalled();
    expect(actualizado.pdfSummary).toBeNull();
  });

  test('caso real CREA OS reproducido: sin el guard, el texto vacío hubiera generado la disculpa del modelo como pdfSummary — con el guard, nunca se llega a llamar a OpenAI', async () => {
    mockGetText.mockResolvedValue({ text: '   \n\n  ' }); // solo whitespace, igual que un PDF de imágenes real

    const actualizado = await subirPdf(business._id, fileFalso);

    expect(createSpy).not.toHaveBeenCalled();
    // null, no la disculpa del modelo ("no puedo resumir...") que se
    // guardaba antes de este fix.
    expect(actualizado.pdfSummary).toBeNull();
  });

  test('extracción exitosa (texto real, por encima del mínimo): SÍ llama a OpenAI y guarda el resumen real', async () => {
    const textoReal =
      'CREA OS es un software SaaS de ventas con Inteligencia Artificial: agente de ventas 24/7, ' +
      'CRM, pipeline, seguimiento automático, calificación de leads y automatización comercial.';
    mockGetText.mockResolvedValue({ text: textoReal });
    createSpy.mockResolvedValue({
      choices: [{ message: { content: 'Resumen real generado por el modelo.' } }],
    });

    const actualizado = await subirPdf(business._id, fileFalso);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(actualizado.pdfSummary).toBe('Resumen real generado por el modelo.');
    expect(actualizado.pdfExtractedText).toContain('CREA OS es un software SaaS');
  });

  // Bloque 3 (§45-50, 20/sep/2026) — RAG del PDF: subirPdf() encola la
  // indexación EN PARALELO al flujo de resumen de arriba, sin reemplazarlo.
  test('extracción exitosa: además del resumen de siempre, crea el BusinessDocument y encola su indexación con el texto CRUDO (no el limpio)', async () => {
    const textoConSeparadorDePagina = '-- 1 of 1 --\nCREA OS es un software SaaS de ventas con Inteligencia Artificial y automatización comercial real para negocios.';
    mockGetText.mockResolvedValue({ text: textoConSeparadorDePagina });
    createSpy.mockResolvedValue({ choices: [{ message: { content: 'Resumen.' } }] });

    await subirPdf(business._id, fileFalso);

    const BusinessDocument = require('../business-knowledge/businessDocument.model');
    const documento = await BusinessDocument.findOne({ business: business._id });
    expect(documento).not.toBeNull();
    expect(documento.status).toBe('uploaded');
    expect(documento.sourceAsset).toEqual({ publicId: 'creaos/businesses/x/pdf/abc', resourceType: 'raw' });

    expect(enqueueIndexBusinessDocument).toHaveBeenCalledWith({
      documentId: documento._id,
      textoCompleto: textoConSeparadorDePagina, // crudo, CON el separador de página
    });
  });

  test('extracción fallida (texto vacío): NO crea BusinessDocument ni encola nada — no hay nada real que indexar', async () => {
    mockGetText.mockResolvedValue({ text: '' });

    await subirPdf(business._id, fileFalso);

    const BusinessDocument = require('../business-knowledge/businessDocument.model');
    expect(await BusinessDocument.countDocuments({ business: business._id })).toBe(0);
    expect(enqueueIndexBusinessDocument).not.toHaveBeenCalled();
  });

  test('si falla la creación del BusinessDocument (ej. Mongo momentáneamente caído): subirPdf() NO rompe — el resumen/PDF ya se guardó igual', async () => {
    const textoReal = 'CREA OS es un software SaaS de ventas con Inteligencia Artificial y automatización comercial.';
    mockGetText.mockResolvedValue({ text: textoReal });
    createSpy.mockResolvedValue({ choices: [{ message: { content: 'Resumen.' } }] });
    enqueueIndexBusinessDocument.mockRejectedValueOnce(new Error('Redis caído'));

    const actualizado = await subirPdf(business._id, fileFalso);

    // El flujo principal (lo único que le importa al dueño del negocio) sigue intacto.
    expect(actualizado.pdfSummary).toBe('Resumen.');
    expect(actualizado.pdfUrl).toBe('https://cloudinary.test/negocio.pdf');
  });
});
