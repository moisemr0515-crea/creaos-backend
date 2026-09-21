const express = require('express');
const multer = require('multer');
const request = require('supertest');
const XLSX = require('xlsx');
const { validarArchivo, validarContenidoArchivo } = require('./fileContentValidation.middleware');
const { errorHandler } = require('./error.middleware');

const archivo = (originalname, mimetype, buffer) => ({ originalname, mimetype, buffer });

const crearXlsxValido = () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['sku', 'stock'], ['ABC', 3]]), 'Productos');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

describe('validación central de contenido real de uploads', () => {
  test('acepta PDF válido por firma y rechaza .pdf/MIME PDF con contenido falso', () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
    expect(validarArchivo(archivo('documento.pdf', 'application/pdf', pdf), ['pdf'])).toBe('pdf');

    expect(() => validarArchivo(archivo('documento.pdf', 'application/pdf', Buffer.from('MZ ejecutable falso')), ['pdf']))
      .toThrow('El contenido del archivo no corresponde a un PDF válido.');
    expect(() => validarArchivo(archivo('documento.pdf', 'application/pdf', Buffer.from('MZ falso %PDF-1.7')), ['pdf']))
      .toThrow('El contenido del archivo no corresponde a un PDF válido.');
    expect(() => validarArchivo(archivo('sin-extension.bin', 'application/pdf', Buffer.from('contenido falso')), ['pdf']))
      .toThrow('La extensión del archivo no está permitida.');
  });

  test('acepta XLSX OOXML real y rechaza ZIP/archivo arbitrario renombrado', () => {
    expect(validarArchivo(archivo(
      'inventario.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      crearXlsxValido()
    ), ['xlsx'])).toBe('xlsx');

    expect(() => validarArchivo(archivo(
      'inventario.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Buffer.from('ZIP que no es Office')])
    ), ['xlsx'])).toThrow('El contenido del archivo no corresponde a un XLSX válido.');
  });

  test('conserva CSV UTF-8 válido y rechaza contenido binario renombrado', () => {
    expect(validarArchivo(archivo('inventario.csv', 'text/csv', Buffer.from('sku,precio\nABC,10\n')), ['csv'])).toBe('csv');
    expect(() => validarArchivo(archivo('inventario.csv', 'text/csv', Buffer.from([0x00, 0x01, 0x02])), ['csv']))
      .toThrow('El contenido del archivo no corresponde a un CSV válido.');
  });

  test.each([
    ['foto.jpg', 'image/jpeg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), 'jpeg'],
    ['foto.png', 'image/png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'png'],
    ['foto.webp', 'image/webp', Buffer.from('RIFF0000WEBP', 'ascii'), 'webp'],
  ])('acepta imagen soportada válida: %s', (name, mime, buffer, expected) => {
    expect(validarArchivo(archivo(name, mime, buffer), ['jpeg', 'png', 'webp'])).toBe(expected);
  });

  test('rechaza una imagen falsa renombrada', () => {
    expect(() => validarArchivo(archivo('foto.jpg', 'image/jpeg', Buffer.from('no soy imagen')), ['jpeg', 'png', 'webp']))
      .toThrow('El contenido del archivo no corresponde a un JPEG válido.');
  });

  test('acepta firmas MP4/3GP admitidas y no amplía formatos', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom', 'ascii')]);
    const threeGp = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftyp3gp5', 'ascii')]);
    expect(validarArchivo(archivo('video.mp4', 'video/mp4', mp4), ['mp4', '3gp'])).toBe('mp4');
    expect(validarArchivo(archivo('video.3gp', 'video/3gpp', threeGp), ['mp4', '3gp'])).toBe('3gp');
  });

  test('un archivo rechazado corta la cadena antes del procesamiento', async () => {
    const procesamiento = jest.fn((_req, res) => res.status(201).json({ ok: true }));
    const app = express();
    app.post(
      '/pdf',
      multer({ storage: multer.memoryStorage() }).single('pdf'),
      validarContenidoArchivo(['pdf']),
      procesamiento
    );
    app.use(errorHandler);

    const response = await request(app)
      .post('/pdf')
      .attach('pdf', Buffer.from('contenido falso'), { filename: 'documento.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('El contenido del archivo no corresponde a un PDF válido.');
    expect(procesamiento).not.toHaveBeenCalled();
  });
});
