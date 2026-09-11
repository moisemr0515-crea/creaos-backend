// Test real (Jest, Mongo real) del modelo Product — CREA Product
// Intelligence™ V1.0, Etapa 2/10. Cubre las 2 invariantes que viven en el
// esquema mismo (no en el service): el índice único {business, sku}, y que
// availableStock nunca se pueda guardar manualmente ni quedar negativo.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_model';

describe('Product (modelo)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init(); // el índice único y el de texto tardan en construirse
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

  test('sku se normaliza a mayúsculas', async () => {
    const producto = await Product.create({ business: business._id, sku: 'tq-mor-100', name: 'Harina de Moringa' });
    expect(producto.sku).toBe('TQ-MOR-100');
  });

  test('{business, sku} único: no se puede crear 2 productos con el mismo SKU en el mismo negocio', async () => {
    await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa 100 cápsulas' });

    await expect(
      Product.create({ business: business._id, sku: 'MOR-001', name: 'Otro producto, mismo SKU' })
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  test('el mismo SKU SÍ puede existir en 2 negocios distintos (sin colisión entre tenants)', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });

    await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa negocio A' });
    const productoB = await Product.create({ business: otroBusiness._id, sku: 'MOR-001', name: 'Moringa negocio B' });

    expect(productoB.sku).toBe('MOR-001');
  });

  test('availableStock se calcula (physicalStock - reservedStock), no se puede escribir directamente', async () => {
    const producto = await Product.create({
      business: business._id,
      sku: 'MOR-001',
      name: 'Moringa',
      physicalStock: 43,
      reservedStock: 3,
      // Un campo virtual no persiste aunque se intente asignar por fuera del schema.
      availableStock: 999,
    });

    expect(producto.availableStock).toBe(40);
    expect(producto.toObject().availableStock).toBe(40);
  });

  test('reservedStock no puede ser mayor que physicalStock (nunca disponible negativo)', async () => {
    const producto = new Product({
      business: business._id,
      sku: 'MOR-001',
      name: 'Moringa',
      physicalStock: 5,
      reservedStock: 10,
    });

    await expect(producto.validate()).rejects.toThrow(/stock reservado no puede ser mayor/);
  });

  test('price/currency por default quedan en null (sin moneda hardcodeada en el modelo)', async () => {
    const producto = await Product.create({ business: business._id, sku: 'SRV-001', name: 'Servicio de consultoría', trackInventory: false });
    expect(producto.price).toBeNull();
    expect(producto.currency).toBeNull();
  });

  test('active por default es true, y no crea un producto sin `business` o sin `sku`/`name`', async () => {
    const producto = await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa' });
    expect(producto.active).toBe(true);

    await expect(Product.create({ sku: 'X', name: 'Y' })).rejects.toThrow();
    await expect(Product.create({ business: business._id, name: 'Sin SKU' })).rejects.toThrow();
    await expect(Product.create({ business: business._id, sku: 'SIN-NOMBRE' })).rejects.toThrow();
  });
});
