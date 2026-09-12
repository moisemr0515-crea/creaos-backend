// Test real (Jest, Mongo real) de policyImport.service.js — CREA SALES
// AI™ C.2, Etapa 9/11. Mismo criterio que productImport.service.test.js:
// cubre validación, upsert por {business,code} (incluyendo que un code
// EXISTENTE solo actualiza los campos que la fila trae con valor), y que
// preview nunca persiste nada.
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Business = require('../businesses/business.model');
const Policy = require('./policy.model');
const { previsualizarImportacion, confirmarImportacion } = require('./policyImport.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_policy_import_service';

const HEADERS = ['code', 'title', 'category', 'policyType', 'statement', 'priority', 'status'];

const csvBuffer = (headers, rows) => {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [headers.join(','), ...rows.map((r) => r.map(escape).join(','))];
  return Buffer.from(lineas.join('\n'), 'utf8');
};

const csvFile = (headers, rows, name = 'policies.csv') => ({
  originalname: name,
  buffer: csvBuffer(headers, rows),
  mimetype: 'text/csv',
  size: 100,
});

const xlsxFile = (headers, rows, name = 'policies.xlsx') => {
  const data = rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  const sheet = XLSX.utils.json_to_sheet(data, { header: headers });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Policies');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { originalname: name, buffer, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buffer.length };
};

const filaCompleta = (overrides = {}) => {
  const base = {
    code: 'RETURNS-001',
    title: 'Cambios de productos',
    category: 'returns',
    policyType: 'rule',
    statement: 'Se aceptan cambios hasta 7 días después de la compra.',
    priority: '60',
    status: 'active',
    ...overrides,
  };
  return HEADERS.map((h) => base[h]);
};

const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('policyImport.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Policy.init();
  });

  afterAll(async () => {
    await Policy.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Policy.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  describe('previsualizarImportacion', () => {
    test('parsea CSV válido, marca "crear" para code nuevo, NO persiste nada', async () => {
      const file = csvFile(HEADERS, [filaCompleta()]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.resumen).toEqual({ totalFilas: 1, validas: 1, conAdvertencias: 0, conErrores: 0 });
      expect(resultado.filas[0].accion).toBe('crear');
      expect(resultado.filas[0].code).toBe('RETURNS-001');

      const total = await Policy.countDocuments({});
      expect(total).toBe(0);
    });

    test('parsea XLSX igual que CSV', async () => {
      const file = xlsxFile(HEADERS, [filaCompleta()]);
      const resultado = await previsualizarImportacion(business._id, file);
      expect(resultado.resumen.validas).toBe(1);
    });

    test('code existente en este negocio → marca "actualizar"', async () => {
      await Policy.create({
        business: business._id,
        code: 'RETURNS-001',
        title: 'Existente',
        category: 'returns',
        policyType: 'rule',
        statement: 'Statement existente',
      });

      const file = csvFile(HEADERS, [filaCompleta()]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.filas[0].accion).toBe('actualizar');
    });

    test('code de OTRO negocio es invisible — se trata como "crear", nunca pisa el ajeno', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await Policy.create({
        business: otroBusiness._id,
        code: 'RETURNS-001',
        title: 'De otro negocio',
        category: 'returns',
        policyType: 'rule',
        statement: 'Statement ajeno',
      });

      const file = csvFile(HEADERS, [filaCompleta()]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.filas[0].accion).toBe('crear');
    });

    test.each([
      ['code vacío', filaCompleta({ code: '' })],
      ['title vacío', filaCompleta({ title: '' })],
      ['category inválida', filaCompleta({ category: 'no-existe' })],
      ['policyType inválido', filaCompleta({ policyType: 'no-existe' })],
      ['statement vacío', filaCompleta({ statement: '' })],
      ['priority fuera de rango', filaCompleta({ priority: '150' })],
      ['status inválido', filaCompleta({ status: 'no-existe' })],
    ])('marca error de validación: %s', async (_desc, fila) => {
      const file = csvFile(HEADERS, [fila]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.resumen.conErrores).toBe(1);
      expect(resultado.filas[0].errores.length).toBeGreaterThan(0);
    });

    test('code duplicado DENTRO del archivo: la 2da fila marca error', async () => {
      const file = csvFile(HEADERS, [filaCompleta(), filaCompleta({ title: 'Otro título' })]);
      const resultado = await previsualizarImportacion(business._id, file);

      expect(resultado.filas[0].errores).toEqual([]);
      expect(resultado.filas[1].errores).toEqual(expect.arrayContaining([expect.stringContaining('duplicado')]));
    });

    test('columna desconocida: advertencia, no error — no bloquea la fila', async () => {
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

    test('formato no soportado → 400', async () => {
      const file = { originalname: 'archivo.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 };
      await expect(previsualizarImportacion(business._id, file)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('confirmarImportacion', () => {
    test('crea Policies nuevas, con source:"import" y el nombre de archivo como reference', async () => {
      const file = csvFile(HEADERS, [filaCompleta()]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen).toMatchObject({ nuevos: 1, actualizados: 0, erroresValidacion: 0, erroresEscritura: 0 });

      const enDb = await Policy.findOne({ business: business._id, code: 'RETURNS-001' });
      expect(enDb).not.toBeNull();
      expect(enDb.source.type).toBe('import');
      expect(enDb.source.reference).toBe('policies.csv');
      expect(enDb.createdBy.toString()).toBe(actor._id.toString());
    });

    test('actualiza SOLO los campos que la fila trae con valor — no borra en silencio los demás', async () => {
      await Policy.create({
        business: business._id,
        code: 'RETURNS-001',
        title: 'Título original',
        category: 'returns',
        policyType: 'rule',
        statement: 'Statement original',
        customerFacingText: 'Texto para el cliente original',
        tags: ['original'],
      });

      // La fila del archivo NO trae customerFacingText ni tags — deben
      // sobrevivir intactos tras la actualización.
      const file = csvFile(HEADERS, [filaCompleta({ statement: 'Statement actualizado' })]);
      await confirmarImportacion(business._id, actor, file);

      const enDb = await Policy.findOne({ business: business._id, code: 'RETURNS-001' });
      expect(enDb.statement).toBe('Statement actualizado');
      expect(enDb.customerFacingText).toBe('Texto para el cliente original');
      expect(enDb.tags).toEqual(['original']);
    });

    test('filas con error de validación NO se escriben, se reportan aparte', async () => {
      const file = csvFile(HEADERS, [filaCompleta(), filaCompleta({ code: 'BAD', category: 'no-existe' })]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen.nuevos).toBe(1);
      expect(resultado.resumen.erroresValidacion).toBe(1);
      expect(resultado.erroresValidacion).toHaveLength(1);

      const total = await Policy.countDocuments({ business: business._id });
      expect(total).toBe(1);
    });

    test('re-parsea y revalida desde el archivo — no confía en ningún preview previo', async () => {
      const fileMalo = csvFile(HEADERS, [filaCompleta({ category: 'no-existe' })]);
      await expect(confirmarImportacion(business._id, actor, fileMalo)).resolves.toMatchObject({
        resumen: expect.objectContaining({ nuevos: 0, erroresValidacion: 1 }),
      });
    });

    test('vigencia: effectiveFrom/effectiveUntil se parsean y se validan igual que en el CRUD manual', async () => {
      const headersConVigencia = [...HEADERS, 'effectiveFrom', 'effectiveUntil'];
      const file = csvFile(headersConVigencia, [[...filaCompleta(), '2020-01-01', '2019-01-01']]); // hasta < desde

      const resultado = await previsualizarImportacion(business._id, file);
      expect(resultado.filas[0].errores).toEqual(expect.arrayContaining([expect.stringContaining('effectiveUntil debe ser posterior')]));
    });
  });
});
