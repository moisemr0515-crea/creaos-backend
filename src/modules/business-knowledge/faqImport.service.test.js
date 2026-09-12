// Test real (Jest, Mongo real) de faqImport.service.js — CREA SALES AI™
// C.2, Etapa 9/11. Mismo criterio que policyImport.service.test.js, con
// el foco puesto en la diferencia clave: FAQ SIEMPRE CREA (decisión #4),
// nunca upsert — ni siquiera con la misma pregunta repetida.
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Business = require('../businesses/business.model');
const FAQ = require('./faq.model');
const { previsualizarImportacion, confirmarImportacion } = require('./faqImport.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_faq_import_service';

const HEADERS = ['question', 'answer', 'category', 'priority', 'status'];

const csvBuffer = (headers, rows) => {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [headers.join(','), ...rows.map((r) => r.map(escape).join(','))];
  return Buffer.from(lineas.join('\n'), 'utf8');
};

const csvFile = (headers, rows, name = 'faqs.csv') => ({
  originalname: name,
  buffer: csvBuffer(headers, rows),
  mimetype: 'text/csv',
  size: 100,
});

const xlsxFile = (headers, rows, name = 'faqs.xlsx') => {
  const data = rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  const sheet = XLSX.utils.json_to_sheet(data, { header: headers });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'FAQs');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { originalname: name, buffer, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buffer.length };
};

const filaCompleta = (overrides = {}) => {
  const base = {
    question: '¿Aceptan Yape?',
    answer: 'Sí, aceptamos Yape y Plin.',
    category: 'payments',
    priority: '60',
    status: 'active',
    ...overrides,
  };
  return HEADERS.map((h) => base[h]);
};

const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('faqImport.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await FAQ.init();
  });

  afterAll(async () => {
    await FAQ.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await FAQ.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  describe('previsualizarImportacion', () => {
    test('parsea CSV válido, accion siempre "crear", NO persiste nada', async () => {
      const file = csvFile(HEADERS, [filaCompleta()]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.resumen).toEqual({ totalFilas: 1, validas: 1, conAdvertencias: 0, conErrores: 0 });
      expect(resultado.filas[0].accion).toBe('crear');

      const total = await FAQ.countDocuments({});
      expect(total).toBe(0);
    });

    test('parsea XLSX igual que CSV', async () => {
      const file = xlsxFile(HEADERS, [filaCompleta()]);
      const resultado = await previsualizarImportacion(business._id, file);
      expect(resultado.resumen.validas).toBe(1);
    });

    test('2 filas con la MISMA pregunta: ambas válidas, sin error de "duplicado" (decisión #4)', async () => {
      const file = csvFile(HEADERS, [filaCompleta(), filaCompleta({ answer: 'Otra respuesta' })]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.resumen.conErrores).toBe(0);
      expect(resultado.filas[0].errores).toEqual([]);
      expect(resultado.filas[1].errores).toEqual([]);
    });

    test.each([
      ['question vacía', filaCompleta({ question: '' })],
      ['question muy corta', filaCompleta({ question: 'hi' })],
      ['answer vacía', filaCompleta({ answer: '' })],
      ['category inválida', filaCompleta({ category: 'no-existe' })],
      ['priority fuera de rango', filaCompleta({ priority: '150' })],
      ['status inválido', filaCompleta({ status: 'no-existe' })],
    ])('marca error de validación: %s', async (_desc, fila) => {
      const file = csvFile(HEADERS, [fila]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.resumen.conErrores).toBe(1);
    });

    test('columna desconocida: advertencia, no error', async () => {
      const headersConExtra = [...HEADERS, 'columna_rara'];
      const file = csvFile(headersConExtra, [[...filaCompleta(), 'valor cualquiera']]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.resumen.conErrores).toBe(0);
      expect(resultado.advertenciasGenerales[0]).toMatch(/columna_rara/i);
    });

    test('archivo sin filas → 400', async () => {
      const file = csvFile(HEADERS, []);
      await expect(previsualizarImportacion(business._id, file)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('confirmarImportacion', () => {
    test('crea FAQs nuevas, con normalizedQuestion calculada y source:"import"', async () => {
      const file = csvFile(HEADERS, [filaCompleta()]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen).toMatchObject({ nuevos: 1, actualizados: 0, erroresValidacion: 0, erroresEscritura: 0 });

      const enDb = await FAQ.findOne({ business: business._id });
      expect(enDb.normalizedQuestion).toBe('aceptan yape');
      expect(enDb.source.type).toBe('import');
      expect(enDb.source.reference).toBe('faqs.csv');
      expect(enDb.createdBy.toString()).toBe(actor._id.toString());
    });

    test('2 filas con la MISMA pregunta: crea 2 FAQs distintas, nunca actualiza/upsert (decisión #4)', async () => {
      const file = csvFile(HEADERS, [filaCompleta(), filaCompleta({ answer: 'Otra respuesta' })]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen.nuevos).toBe(2);
      const total = await FAQ.countDocuments({ business: business._id, normalizedQuestion: 'aceptan yape' });
      expect(total).toBe(2);
    });

    test('reimportar el mismo archivo 2 veces duplica filas (nunca upsert) — comportamiento esperado, no un bug', async () => {
      const file = csvFile(HEADERS, [filaCompleta()]);
      await confirmarImportacion(business._id, actor, file);
      await confirmarImportacion(business._id, actor, file);

      const total = await FAQ.countDocuments({ business: business._id });
      expect(total).toBe(2);
    });

    test('filas con error de validación NO se escriben, se reportan aparte', async () => {
      const file = csvFile(HEADERS, [filaCompleta(), filaCompleta({ category: 'no-existe' })]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen.nuevos).toBe(1);
      expect(resultado.resumen.erroresValidacion).toBe(1);

      const total = await FAQ.countDocuments({ business: business._id });
      expect(total).toBe(1);
    });
  });
});
