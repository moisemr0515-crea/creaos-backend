// Test real (Jest, Mongo real) — CREA Product Intelligence™ V1.0, Etapa
// 9/10 (integración end-to-end). Cierra un hueco real de cobertura:
// productImport.service.test.js prueba el importador solo, y
// product.service.test.js/ai/tools/index.test.js prueban
// buscarProductos()/consultarStock()/consultarPrecio() solo con productos
// creados a mano — pero ningún test corría las 2 mitades ENCADENADAS:
// importar un producto y confirmar que la IA lo encuentra/consulta de
// inmediato, sin ningún paso manual en el medio, incluyendo el caso de
// reimportar para actualizar el precio.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const { confirmarImportacion } = require('./productImport.service');
const { buscarProductos, consultarStock, consultarPrecio } = require('./product.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_import_ai_integration';

const HEADERS = ['sku', 'nombre', 'descripcion', 'categoria', 'marca', 'precio', 'moneda', 'stock', 'stock_minimo', 'controlar_inventario', 'keywords', 'sinonimos', 'activo'];

const csvBuffer = (headers, rows) => {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [headers.join(','), ...rows.map((r) => r.map(escape).join(','))];
  return Buffer.from(lineas.join('\n'), 'utf8');
};

const csvFile = (rows, name = 'productos.csv') => ({
  originalname: name,
  buffer: csvBuffer(HEADERS, rows),
  mimetype: 'text/csv',
  size: 100,
});

const filaMoringa = (overrides = {}) => {
  const base = {
    sku: 'TQ-MOR-100',
    nombre: 'Harina de Moringa Te Quiero',
    descripcion: 'Cápsulas de moringa en polvo',
    categoria: 'suplementos',
    marca: 'Te Quiero',
    precio: '50',
    moneda: 'PEN',
    stock: '43',
    stock_minimo: '5',
    controlar_inventario: 'si',
    keywords: 'moringa, capsulas, pastillas',
    sinonimos: '',
    activo: 'si',
    ...overrides,
  };
  return HEADERS.map((h) => base[h]);
};

const actor = { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' };

describe('productImport → tools de IA — integración end-to-end', () => {
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
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
  });

  test('un producto recién importado es encontrable de inmediato por search_products (buscarProductos)', async () => {
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa()]));

    const resultados = await buscarProductos(business._id, 'pastillas de moringa');
    expect(resultados).toHaveLength(1);
    expect(resultados[0].sku).toBe('TQ-MOR-100');
    expect(resultados[0].price).toBe(50);
  });

  test('check_stock/get_price reflejan de inmediato el stock/precio importado', async () => {
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa()]));
    const producto = await Product.findOne({ business: business._id, sku: 'TQ-MOR-100' });

    const stock = await consultarStock(business._id, producto._id);
    expect(stock).toMatchObject({ trackInventory: true, physicalStock: 43, availableStock: 43, inStock: true });

    const precio = await consultarPrecio(business._id, producto._id);
    expect(precio).toMatchObject({ price: 50, currency: 'PEN', priceAvailable: true });
  });

  test('reimportar con un precio distinto actualiza lo que get_price() devuelve, sin crear un producto duplicado', async () => {
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa({ precio: '50' })]));
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa({ precio: '65' })]));

    expect(await Product.countDocuments({ business: business._id, sku: 'TQ-MOR-100' })).toBe(1);

    const producto = await Product.findOne({ business: business._id, sku: 'TQ-MOR-100' });
    const precio = await consultarPrecio(business._id, producto._id);
    expect(precio.price).toBe(65);
  });

  test('reimportar sin la columna de keywords NO le borra las keywords ya cargadas — search_products lo sigue encontrando', async () => {
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa({ keywords: 'moringa, capsulas, pastillas' })]));

    // Reimportación parcial (solo sku/nombre/precio) — caso real: "solo quiero actualizar el precio".
    const headersParciales = ['sku', 'nombre', 'precio'];
    const bufferParcial = csvBuffer(headersParciales, [['TQ-MOR-100', 'Harina de Moringa Te Quiero', '55']]);
    await confirmarImportacion(business._id, actor, { originalname: 'reimport.csv', buffer: bufferParcial, mimetype: 'text/csv', size: 50 });

    const resultados = await buscarProductos(business._id, 'pastillas');
    expect(resultados).toHaveLength(1); // las keywords originales seguían ahí
    expect(resultados[0].price).toBe(55); // y el precio sí se actualizó
  });

  test('aislamiento multi-tenant: un producto importado en el Negocio A es invisible para buscarProductos/consultarStock/consultarPrecio del Negocio B', async () => {
    const negocioB = await Business.create({ name: 'Negocio B' });
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa()]));
    const productoDeA = await Product.findOne({ business: business._id, sku: 'TQ-MOR-100' });

    const resultadosEnB = await buscarProductos(negocioB._id, 'moringa');
    expect(resultadosEnB).toEqual([]);

    await expect(consultarStock(negocioB._id, productoDeA._id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(consultarPrecio(negocioB._id, productoDeA._id)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('un producto con errores de validación NUNCA se escribe, así que la IA nunca lo encuentra', async () => {
    await confirmarImportacion(business._id, actor, csvFile([filaMoringa({ sku: '' })])); // SKU vacío → error, no se escribe

    const resultados = await buscarProductos(business._id, 'moringa');
    expect(resultados).toEqual([]);
    expect(await Product.countDocuments({ business: business._id })).toBe(0);
  });
});
