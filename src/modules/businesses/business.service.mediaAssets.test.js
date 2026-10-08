// Test real (Jest, Mongo real) de business.service.js#subirVideoPresentacion()
// y #subirBrochure() — Paso 2/3 de la auditoría de factibilidad de
// send_media (12/sep/2026). A diferencia de subirPdf(), estos 2 NO
// extraen ni procesan contenido: son archivos para REENVIAR tal cual por
// WhatsApp (send_media), guardados aparte de pdfUrl/pdfExtractedText/
// pdfSummary (el PDF de CONOCIMIENTO del agente, un concepto distinto).
// Cloudinary se mockea, sin red real.
const mongoose = require('mongoose');
const Business = require('./business.model');
require('../users/user.model'); // ambas funciones hacen populate('createdBy', ...)

jest.mock('../../utils/cloudinary', () => ({
  subirBuffer: jest.fn(),
  eliminarPorUrl: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/documentStorage', () => ({
  isConfigured: jest.fn().mockReturnValue(false),
  uploadDocument: jest.fn(),
  deleteDocument: jest.fn().mockResolvedValue(undefined),
}));

const documentStorage = require('../../utils/documentStorage');const { subirBuffer, eliminarPorUrl } = require('../../utils/cloudinary');
const { subirVideoPresentacion, subirBrochure } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_media_assets';

describe('business.service#subirVideoPresentacion()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    documentStorage.isConfigured.mockReturnValue(false);
    documentStorage.uploadDocument.mockReset();
    documentStorage.deleteDocument.mockReset().mockResolvedValue(undefined);
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
  });

  const videoFalso = { buffer: Buffer.from('contenido-video-falso'), originalname: 'presentacion.mp4', mimetype: 'video/mp4', size: 21 };

  test('sube a Cloudinary con resource_type:"video" y guarda presentationVideoUrl', async () => {
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/video/authenticated/presentacion.mp4', public_id: 'video/presentacion', resource_type: 'video', format: 'mp4', type: 'authenticated' });

    const actualizado = await subirVideoPresentacion(business._id, videoFalso);

    expect(subirBuffer).toHaveBeenCalledWith(
      videoFalso.buffer,
      expect.objectContaining({ resource_type: 'video', type: 'authenticated', folder: expect.stringContaining(String(business._id)) }),
    );
    expect(actualizado.presentationVideoUrl).toBe('https://cloudinary.test/video/authenticated/presentacion.mp4');
    expect(actualizado.presentationVideoAsset).toEqual(expect.objectContaining({
      publicId: 'video/presentacion', deliveryType: 'authenticated', businessId: business._id,
      mimeType: 'video/mp4', originalName: 'presentacion.mp4', size: 21,
    }));

    // Query independiente — no confiar solo en lo que devuelve la propia llamada.
    const releido = await Business.findById(business._id);
    expect(releido.presentationVideoUrl).toBe('https://cloudinary.test/video/authenticated/presentacion.mp4');
  });

  test('no toca pdfUrl/pdfExtractedText/pdfSummary — son un concepto distinto', async () => {
    await Business.findByIdAndUpdate(business._id, { pdfUrl: 'https://cloudinary.test/viejo.pdf', pdfSummary: 'Resumen real' });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/video/authenticated/presentacion.mp4', public_id: 'video/presentacion', resource_type: 'video', type: 'authenticated' });

    const actualizado = await subirVideoPresentacion(business._id, videoFalso);

    expect(actualizado.pdfUrl).toBe('https://cloudinary.test/viejo.pdf');
    expect(actualizado.pdfSummary).toBe('Resumen real');
  });

  test('subir un video nuevo borra el anterior en Cloudinary (best-effort)', async () => {
    await Business.findByIdAndUpdate(business._id, { presentationVideoUrl: 'https://cloudinary.test/viejo.mp4' });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/video/authenticated/nuevo.mp4', public_id: 'video/nuevo', resource_type: 'video', type: 'authenticated' });

    await subirVideoPresentacion(business._id, videoFalso);

    expect(eliminarPorUrl).toHaveBeenCalledWith('https://cloudinary.test/viejo.mp4', expect.anything());
  });

  test('negocio inexistente: AppError 404, nunca llama a Cloudinary', async () => {
    const idInexistente = new mongoose.Types.ObjectId();

    await expect(subirVideoPresentacion(idInexistente, videoFalso)).rejects.toThrow('Negocio no encontrado');
    expect(subirBuffer).not.toHaveBeenCalled();
  });
});

describe('business.service#subirBrochure()', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    documentStorage.isConfigured.mockReturnValue(false);
    documentStorage.uploadDocument.mockReset();
    documentStorage.deleteDocument.mockReset().mockResolvedValue(undefined);
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
  });

  const brochureFalso = { buffer: Buffer.from('contenido-pdf-falso'), originalname: 'brochure-creaos.pdf', mimetype: 'application/pdf', size: 19 };

  test('sube a Cloudinary con resource_type:"raw" y guarda brochureUrl + brochureFilename (para el type:"document" de Gupshup)', async () => {
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/raw/authenticated/brochure.pdf', public_id: 'brochure/doc', resource_type: 'raw', format: 'pdf', type: 'authenticated' });

    const actualizado = await subirBrochure(business._id, brochureFalso);

    expect(subirBuffer).toHaveBeenCalledWith(
      brochureFalso.buffer,
      expect.objectContaining({ resource_type: 'raw', type: 'authenticated', format: 'pdf' }),
    );
    expect(actualizado.brochureUrl).toBe('https://cloudinary.test/raw/authenticated/brochure.pdf');
    expect(actualizado.brochureFilename).toBe('brochure-creaos.pdf');
    expect(actualizado.brochureAsset).toEqual(expect.objectContaining({
      publicId: 'brochure/doc', deliveryType: 'authenticated', businessId: business._id,
      mimeType: 'application/pdf', originalName: 'brochure-creaos.pdf', size: 19,
    }));

    const releido = await Business.findById(business._id);
    expect(releido.brochureFilename).toBe('brochure-creaos.pdf');
  });

  test('NO extrae texto ni genera resumen — es un archivo para reenviar, no para leer (a diferencia de subirPdf())', async () => {
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/raw/authenticated/brochure.pdf', public_id: 'brochure/doc', resource_type: 'raw', type: 'authenticated' });

    const actualizado = await subirBrochure(business._id, brochureFalso);

    expect(actualizado.pdfExtractedText).toBeNull();
    expect(actualizado.pdfSummary).toBeNull();
  });

  test('subir un brochure nuevo borra el anterior en Cloudinary (best-effort)', async () => {
    await Business.findByIdAndUpdate(business._id, { brochureUrl: 'https://cloudinary.test/viejo.pdf' });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/raw/authenticated/nuevo.pdf', public_id: 'brochure/nuevo', resource_type: 'raw', type: 'authenticated' });

    await subirBrochure(business._id, brochureFalso);

    expect(eliminarPorUrl).toHaveBeenCalledWith('https://cloudinary.test/viejo.pdf', expect.anything());
  });

  test('negocio inexistente: AppError 404, nunca llama a Cloudinary', async () => {
    const idInexistente = new mongoose.Types.ObjectId();

    await expect(subirBrochure(idInexistente, brochureFalso)).rejects.toThrow('Negocio no encontrado');
    expect(subirBuffer).not.toHaveBeenCalled();
  });

  test('5 MB conserva el fallback Cloudinary authenticated cuando storage documental no está configurado', async () => {
    const file = { ...brochureFalso, size: 5 * 1024 * 1024 };
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/raw/authenticated/5mb.pdf', public_id: 'brochure/5mb', resource_type: 'raw', format: 'pdf', type: 'authenticated' });

    const actualizado = await subirBrochure(business._id, file);

    expect(actualizado.brochureAsset.provider).toBe('cloudinary');
    expect(actualizado.brochureAsset.deliveryType).toBe('authenticated');
  });

  test('12.5 MB falla cerrado si faltan credenciales de storage documental', async () => {
    const file = { ...brochureFalso, size: Math.floor(12.5 * 1024 * 1024) };
    await expect(subirBrochure(business._id, file)).rejects.toMatchObject({ statusCode: 503 });
    expect(subirBuffer).not.toHaveBeenCalled();
  });

  test.each([12.5, 50, 99.5])('%s MB usa storage documental privado y persiste metadata tenant-safe', async (megabytes) => {
    documentStorage.isConfigured.mockReturnValue(true);
    const file = { ...brochureFalso, size: Math.floor(megabytes * 1024 * 1024) };
    const storageKey = `businesses/${business._id}/brochures/documento.pdf`;
    documentStorage.uploadDocument.mockResolvedValue({ storageKey });

    const actualizado = await subirBrochure(business._id, file);

    expect(documentStorage.uploadDocument).toHaveBeenCalledWith({ businessId: business._id, file });
    expect(subirBuffer).not.toHaveBeenCalled();
    expect(actualizado.brochureUrl).toBe(`document-storage://${storageKey}`);
    expect(actualizado.brochureAsset).toEqual(expect.objectContaining({
      provider: 'documentStorage', storageKey, deliveryType: 'signed', businessId: business._id,
      size: file.size,
    }));
  });

  test('más de 100 MB se rechaza antes de llamar a cualquier provider', async () => {
    documentStorage.isConfigured.mockReturnValue(true);
    const file = { ...brochureFalso, size: 100 * 1024 * 1024 + 1 };
    await expect(subirBrochure(business._id, file)).rejects.toMatchObject({ statusCode: 413 });
    expect(documentStorage.uploadDocument).not.toHaveBeenCalled();
    expect(subirBuffer).not.toHaveBeenCalled();
  });});
