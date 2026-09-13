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

const { subirBuffer, eliminarPorUrl } = require('../../utils/cloudinary');
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
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
  });

  const videoFalso = { buffer: Buffer.from('contenido-video-falso'), originalname: 'presentacion.mp4' };

  test('sube a Cloudinary con resource_type:"video" y guarda presentationVideoUrl', async () => {
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/presentacion.mp4' });

    const actualizado = await subirVideoPresentacion(business._id, videoFalso);

    expect(subirBuffer).toHaveBeenCalledWith(
      videoFalso.buffer,
      expect.objectContaining({ resource_type: 'video', folder: expect.stringContaining(String(business._id)) }),
    );
    expect(actualizado.presentationVideoUrl).toBe('https://cloudinary.test/presentacion.mp4');

    // Query independiente — no confiar solo en lo que devuelve la propia llamada.
    const releido = await Business.findById(business._id);
    expect(releido.presentationVideoUrl).toBe('https://cloudinary.test/presentacion.mp4');
  });

  test('no toca pdfUrl/pdfExtractedText/pdfSummary — son un concepto distinto', async () => {
    await Business.findByIdAndUpdate(business._id, { pdfUrl: 'https://cloudinary.test/viejo.pdf', pdfSummary: 'Resumen real' });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/presentacion.mp4' });

    const actualizado = await subirVideoPresentacion(business._id, videoFalso);

    expect(actualizado.pdfUrl).toBe('https://cloudinary.test/viejo.pdf');
    expect(actualizado.pdfSummary).toBe('Resumen real');
  });

  test('subir un video nuevo borra el anterior en Cloudinary (best-effort)', async () => {
    await Business.findByIdAndUpdate(business._id, { presentationVideoUrl: 'https://cloudinary.test/viejo.mp4' });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/nuevo.mp4' });

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
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
  });

  const brochureFalso = { buffer: Buffer.from('contenido-pdf-falso'), originalname: 'brochure-creaos.pdf' };

  test('sube a Cloudinary con resource_type:"raw" y guarda brochureUrl + brochureFilename (para el type:"document" de Gupshup)', async () => {
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/brochure.pdf' });

    const actualizado = await subirBrochure(business._id, brochureFalso);

    expect(subirBuffer).toHaveBeenCalledWith(
      brochureFalso.buffer,
      expect.objectContaining({ resource_type: 'raw', format: 'pdf' }),
    );
    expect(actualizado.brochureUrl).toBe('https://cloudinary.test/brochure.pdf');
    expect(actualizado.brochureFilename).toBe('brochure-creaos.pdf');

    const releido = await Business.findById(business._id);
    expect(releido.brochureFilename).toBe('brochure-creaos.pdf');
  });

  test('NO extrae texto ni genera resumen — es un archivo para reenviar, no para leer (a diferencia de subirPdf())', async () => {
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/brochure.pdf' });

    const actualizado = await subirBrochure(business._id, brochureFalso);

    expect(actualizado.pdfExtractedText).toBeNull();
    expect(actualizado.pdfSummary).toBeNull();
  });

  test('subir un brochure nuevo borra el anterior en Cloudinary (best-effort)', async () => {
    await Business.findByIdAndUpdate(business._id, { brochureUrl: 'https://cloudinary.test/viejo.pdf' });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/nuevo.pdf' });

    await subirBrochure(business._id, brochureFalso);

    expect(eliminarPorUrl).toHaveBeenCalledWith('https://cloudinary.test/viejo.pdf', expect.anything());
  });

  test('negocio inexistente: AppError 404, nunca llama a Cloudinary', async () => {
    const idInexistente = new mongoose.Types.ObjectId();

    await expect(subirBrochure(idInexistente, brochureFalso)).rejects.toThrow('Negocio no encontrado');
    expect(subirBuffer).not.toHaveBeenCalled();
  });
});
