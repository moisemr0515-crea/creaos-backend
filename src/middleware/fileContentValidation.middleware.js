const path = require('path');
const { AppError } = require('./error.middleware');

const FORMATOS = {
  pdf: {
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    label: 'PDF',
  },
  csv: {
    extensions: ['.csv'],
    mimeTypes: ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
    label: 'CSV',
  },
  xls: {
    extensions: ['.xls'],
    mimeTypes: ['application/vnd.ms-excel', 'application/octet-stream'],
    label: 'XLS',
  },
  xlsx: {
    extensions: ['.xlsx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
      'application/zip',
    ],
    label: 'XLSX',
  },
  jpeg: {
    extensions: ['.jpg', '.jpeg'],
    mimeTypes: ['image/jpeg'],
    label: 'JPEG',
  },
  png: {
    extensions: ['.png'],
    mimeTypes: ['image/png'],
    label: 'PNG',
  },
  webp: {
    extensions: ['.webp'],
    mimeTypes: ['image/webp'],
    label: 'WebP',
  },
  mp4: {
    extensions: ['.mp4'],
    mimeTypes: ['video/mp4'],
    label: 'MP4',
  },
  '3gp': {
    extensions: ['.3gp', '.3gpp'],
    mimeTypes: ['video/3gpp'],
    label: '3GP',
  },
};

const empiezaCon = (buffer, bytes) =>
  buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

const esPdf = (buffer) => {
  // La firma debe abrir el documento. Solo se toleran BOM UTF-8 y whitespace
  // inicial para conservar productores válidos; buscar "%PDF-" en cualquier
  // punto permitiría polyglots (por ejemplo un ejecutable MZ con la cadena
  // PDF incrustada en sus primeros bytes).
  const cabecera = buffer.subarray(0, Math.min(buffer.length, 32)).toString('latin1');
  return /^(?:\xEF\xBB\xBF)?[\x09\x0A\x0C\x0D\x20]*%PDF-/.test(cabecera);
};

const esXls = (buffer) => empiezaCon(buffer, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

const esXlsx = (buffer) => {
  const zip = empiezaCon(buffer, [0x50, 0x4B, 0x03, 0x04])
    || empiezaCon(buffer, [0x50, 0x4B, 0x05, 0x06])
    || empiezaCon(buffer, [0x50, 0x4B, 0x07, 0x08]);
  if (!zip) return false;

  // Los nombres de entrada del contenedor ZIP no están comprimidos. Exigir
  // las partes estructurales de OOXML evita aceptar cualquier ZIP renombrado.
  const contenidoBinario = buffer.toString('latin1');
  return contenidoBinario.includes('[Content_Types].xml')
    && contenidoBinario.includes('xl/workbook.xml');
};

const esCsv = (buffer) => {
  if (!buffer.length || buffer.includes(0x00)) return false;
  const texto = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!texto.trim() || texto.includes('\uFFFD')) return false;
  // CSV no tiene magic bytes. Se rechazan binarios/control chars y se
  // conserva CSV de una sola columna, tabulado, con coma o punto y coma.
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(texto);
};

const esIsoBaseMedia = (buffer) =>
  buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';

const FIRMA_POR_FORMATO = {
  pdf: esPdf,
  csv: esCsv,
  xls: esXls,
  xlsx: esXlsx,
  jpeg: (buffer) => empiezaCon(buffer, [0xFF, 0xD8, 0xFF]),
  png: (buffer) => empiezaCon(buffer, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  webp: (buffer) => buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  mp4: (buffer) => esIsoBaseMedia(buffer) && !buffer.subarray(8, 11).toString('ascii').toLowerCase().startsWith('3g'),
  '3gp': (buffer) => esIsoBaseMedia(buffer) && buffer.subarray(8, 11).toString('ascii').toLowerCase().startsWith('3g'),
};

const validarArchivo = (file, formatosPermitidos) => {
  if (!file?.buffer?.length) {
    throw new AppError('El archivo está vacío o no contiene datos válidos.', 400);
  }

  const extension = path.extname(file.originalname || '').toLowerCase();
  const formato = formatosPermitidos.find((nombre) => FORMATOS[nombre].extensions.includes(extension));
  if (!formato) {
    throw new AppError('La extensión del archivo no está permitida.', 400);
  }

  const config = FORMATOS[formato];
  if (!config.mimeTypes.includes((file.mimetype || '').toLowerCase()) || !FIRMA_POR_FORMATO[formato](file.buffer)) {
    throw new AppError(`El contenido del archivo no corresponde a un ${config.label} válido.`, 400);
  }

  return formato;
};

const validarContenidoArchivo = (formatosPermitidos) => (req, _res, next) => {
  try {
    const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [];
    if (req.file) files.push(req.file);
    files.forEach((file) => validarArchivo(file, formatosPermitidos));
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  FORMATOS,
  validarArchivo,
  validarContenidoArchivo,
};
