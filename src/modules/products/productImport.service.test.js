// Test real (Jest, Mongo real) de productImport.service.js — CREA Product
// Intelligence™ V1.0, Etapa 5/10. Cubre las validaciones de la sección 11
// del documento maestro, el upsert por {business, sku} de la sección 12
// (incluyendo que un producto EXISTENTE solo se actualiza en los campos
// que la fila trae con valor — no se le borran en silencio los que el
// archivo no volvió a completar), y que preview nunca persiste nada.
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const { MAX_FILAS, previsualizarImportacion, confirmarImportacion } = require('./productImport.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_import_service';

const HEADERS = ['sku', 'nombre', 'descripcion', 'categoria', 'marca', 'precio', 'moneda', 'stock', 'stock_minimo', 'controlar_inventario', 'keywords', 'sinonimos', 'activo'];

const csvBuffer = (headers, rows) => {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [headers.join(','), ...rows.map((r) => r.map(escape).join(','))];
  return Buffer.from(lineas.join('\n'), 'utf8');
};

const csvFile = (headers, rows, name = 'productos.csv') => ({
  originalname: name,
  buffer: csvBuffer(headers, rows),
  mimetype: 'text/csv',
  size: 100,
});

const xlsxFile = (headers, rows, name = 'productos.xlsx') => {
  const data = rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  const sheet = XLSX.utils.json_to_sheet(data, { header: headers });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Productos');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { originalname: name, buffer, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buffer.length };
};

// Fila "completa" válida, en el orden de HEADERS — helper para no repetir
// los 13 campos en cada test que no le importa el contenido exacto.
const filaCompleta = (overrides = {}) => {
  const base = {
    sku: 'MOR-001',
    nombre: 'Harina de Moringa',
    descripcion: 'Cápsulas de moringa en polvo',
    categoria: 'suplementos',
    marca: 'Te Quiero',
    precio: '50',
    moneda: 'PEN',
    stock: '43',
    stock_minimo: '5',
    controlar_inventario: 'si',
    keywords: 'moringa, capsulas',
    sinonimos: 'pastillas',
    activo: 'si',
    ...overrides,
  };
  return HEADERS.map((h) => base[h]);
};

const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('productImport.service', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
  });

  afterAll(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  describe('parseo de archivo', () => {
    test('rechaza un archivo sin filas de datos', async () => {
      const file = csvFile(HEADERS, []);
      await expect(previsualizarImportacion(business._id, file)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('rechaza una extensión no soportada', async () => {
      const file = { originalname: 'productos.txt', buffer: Buffer.from('sku,nombre\nA,B'), size: 10 };
      await expect(previsualizarImportacion(business._id, file)).rejects.toMatchObject({ statusCode: 400 });
    });

    test(`rechaza un archivo con más de ${MAX_FILAS} filas`, async () => {
      const filas = Array.from({ length: MAX_FILAS + 1 }, (_, i) => filaCompleta({ sku: `SKU-${i}` }));
      const file = csvFile(HEADERS, filas);
      await expect(previsualizarImportacion(business._id, file)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('parsea XLSX igual que CSV (mismo resultado con el mismo contenido)', async () => {
      const file = xlsxFile(HEADERS, [filaCompleta()]);
      const { resumen } = await previsualizarImportacion(business._id, file);
      expect(resumen).toMatchObject({ totalFilas: 1, validas: 1, conErrores: 0 });
    });

    test('preview NUNCA persiste nada en la base', async () => {
      const file = csvFile(HEADERS, [filaCompleta()]);
      await previsualizarImportacion(business._id, file);
      expect(await Product.countDocuments({})).toBe(0);
    });

    test('encabezados con acentos/mayúsculas se reconocen igual (documento §10.1)', async () => {
      const headersConAcentos = ['SKU', 'Nombre', 'Descripción', 'Categoría', 'Marca', 'Precio', 'Moneda', 'Stock', 'Stock Mínimo', 'Controlar Inventario', 'Keywords', 'Sinónimos', 'Activo'];
      const file = csvFile(headersConAcentos, [filaCompleta()]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores).toEqual([]);
      expect(filas[0].campos.category).toBe('suplementos');
    });
  });

  describe('validaciones de fila (documento §11)', () => {
    test('SKU vacío → error', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ sku: '' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores).toContain('SKU vacío');
    });

    test('nombre vacío → error', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ nombre: '' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores).toContain('Nombre vacío');
    });

    test.each(['abc', '-10'])('precio inválido ("%s") → error', async (precio) => {
      const file = csvFile(HEADERS, [filaCompleta({ precio })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores.some((e) => e.startsWith('Precio inválido'))).toBe(true);
    });

    test('stock negativo → error', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ stock: '-5' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores.some((e) => e.startsWith('Stock inválido'))).toBe(true);
    });

    test('stock mínimo negativo → error', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ stock_minimo: '-1' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores.some((e) => e.startsWith('Stock mínimo inválido'))).toBe(true);
    });

    test('moneda inválida (no 3 letras) → error', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ moneda: 'PESOS' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].errores.some((e) => e.startsWith('Moneda inválida'))).toBe(true);
    });

    test('SKU duplicado dentro del archivo: la 1ª aparición queda válida, la 2ª con error', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001' }), filaCompleta({ sku: 'mor-001', nombre: 'Otra fila' })]);
      const { filas, resumen } = await previsualizarImportacion(business._id, file);

      expect(filas[0].errores).toEqual([]);
      expect(filas[1].errores).toContain('SKU duplicado dentro del archivo (ya aparece en una fila anterior)');
      expect(resumen).toMatchObject({ totalFilas: 2, validas: 1, conErrores: 1 });
    });

    test('columna desconocida: no bloquea el archivo, se reporta como advertencia general y por fila', async () => {
      const headersConExtra = [...HEADERS, 'columna_rara'];
      const file = csvFile(headersConExtra, [[...filaCompleta(), 'x']]);
      const { filas, resumen, advertenciasGenerales } = await previsualizarImportacion(business._id, file);

      expect(filas[0].errores).toEqual([]);
      expect(advertenciasGenerales.some((a) => a.includes('columna_rara'))).toBe(true);
      expect(filas[0].advertencias.length).toBeGreaterThan(0);
      expect(resumen.conAdvertencias).toBe(1);
    });

    test('resumen cuenta válidas/con errores correctamente en un archivo mixto', async () => {
      const file = csvFile(HEADERS, [
        filaCompleta({ sku: 'A' }),
        filaCompleta({ sku: '' }), // error: SKU vacío
        filaCompleta({ sku: 'B', precio: 'no-es-numero' }), // error: precio inválido
      ]);
      const { resumen } = await previsualizarImportacion(business._id, file);
      expect(resumen).toEqual({ totalFilas: 3, validas: 1, conAdvertencias: 0, conErrores: 2 });
    });
  });

  describe('accion: crear vs actualizar (documento §12)', () => {
    test('SKU nuevo → accion:"crear"', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ sku: 'NUEVO-001' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].accion).toBe('crear');
    });

    test('SKU ya existente en ESTE negocio → accion:"actualizar"', async () => {
      await Product.create({ business: business._id, sku: 'MOR-001', name: 'Ya existe' });
      const file = csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].accion).toBe('actualizar');
    });

    test('SKU existente en OTRO negocio → invisible acá, accion:"crear" (nunca se pisa el de otro negocio)', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      await Product.create({ business: otroBusiness._id, sku: 'MOR-001', name: 'De otro negocio' });

      const file = csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001' })]);
      const { filas } = await previsualizarImportacion(business._id, file);
      expect(filas[0].accion).toBe('crear');
    });
  });

  describe('confirmarImportacion() — upsert real', () => {
    test('crea productos nuevos con todos los campos del archivo', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001' })]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen).toMatchObject({ nuevos: 1, actualizados: 0, erroresValidacion: 0, erroresEscritura: 0 });

      const producto = await Product.findOne({ business: business._id, sku: 'MOR-001' });
      expect(producto).toMatchObject({
        name: 'Harina de Moringa',
        category: 'suplementos',
        price: 50,
        currency: 'PEN',
        physicalStock: 43,
        minimumStock: 5,
        active: true,
        source: 'import',
      });
      expect(producto.keywords).toEqual(['moringa', 'capsulas']);
    });

    test('actualiza un producto existente SOLO con los campos que el archivo trae — no borra los que no volvió a completar', async () => {
      await Product.create({
        business: business._id,
        sku: 'MOR-001',
        name: 'Nombre viejo',
        category: 'viejo',
        keywords: ['moringa', 'suplemento'],
        price: 40,
      });

      // El archivo de reimportación solo trae sku/nombre/precio — sin
      // categoría ni keywords (caso real: "solo quiero actualizar el precio").
      const headersParciales = ['sku', 'nombre', 'precio'];
      const file = csvFile(headersParciales, [['MOR-001', 'Nombre viejo', '55']]);

      const resultado = await confirmarImportacion(business._id, actor, file);
      expect(resultado.resumen).toMatchObject({ nuevos: 0, actualizados: 1 });

      const producto = await Product.findOne({ business: business._id, sku: 'MOR-001' });
      expect(producto.price).toBe(55); // se actualizó
      expect(producto.category).toBe('viejo'); // NO se borró
      expect(producto.keywords).toEqual(['moringa', 'suplemento']); // NO se borró
    });

    test('nunca borra productos que no aparecen en el archivo nuevo', async () => {
      await Product.create({ business: business._id, sku: 'NO-TOCAR', name: 'No debe desaparecer' });

      const file = csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001' })]);
      await confirmarImportacion(business._id, actor, file);

      const sigueExistiendo = await Product.findOne({ business: business._id, sku: 'NO-TOCAR' });
      expect(sigueExistiendo).not.toBeNull();
    });

    test('SKU existente en OTRO negocio: crea uno nuevo en ESTE negocio, nunca toca el del otro', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const productoAjeno = await Product.create({ business: otroBusiness._id, sku: 'MOR-001', name: 'No tocar', price: 999 });

      const file = csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001', precio: '10' })]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen.nuevos).toBe(1);
      const nuevoEnEsteNegocio = await Product.findOne({ business: business._id, sku: 'MOR-001' });
      expect(nuevoEnEsteNegocio.price).toBe(10);

      const ajenoSinTocar = await Product.findById(productoAjeno._id);
      expect(ajenoSinTocar.price).toBe(999);
    });

    test('filas con error de validación no se escriben, quedan reportadas en erroresValidacion', async () => {
      const file = csvFile(HEADERS, [filaCompleta({ sku: 'BUENO' }), filaCompleta({ sku: '' })]);
      const resultado = await confirmarImportacion(business._id, actor, file);

      expect(resultado.resumen).toMatchObject({ nuevos: 1, erroresValidacion: 1 });
      expect(resultado.erroresValidacion).toHaveLength(1);
      expect(resultado.erroresValidacion[0].errores).toContain('SKU vacío');
      expect(await Product.countDocuments({ business: business._id })).toBe(1);
    });

    test('reimportar el mismo archivo 2 veces es idempotente (misma cantidad de productos, la 2da vez todo "actualizado")', async () => {
      const file = () => csvFile(HEADERS, [filaCompleta({ sku: 'MOR-001' })]);

      const primera = await confirmarImportacion(business._id, actor, file());
      expect(primera.resumen).toMatchObject({ nuevos: 1, actualizados: 0 });

      const segunda = await confirmarImportacion(business._id, actor, file());
      expect(segunda.resumen).toMatchObject({ nuevos: 0, actualizados: 1 });

      expect(await Product.countDocuments({ business: business._id })).toBe(1);
    });
  });
});
