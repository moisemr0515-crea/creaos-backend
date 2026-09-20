// Test real (Jest, Mongo real) del modelo Variant — Bloque 4 de la
// auditoría Business Brain (§61, 20/sep/2026). Cubre las invariantes que
// viven en el esquema mismo: {business, sku} único, reservedStock nunca
// mayor a physicalStock, availableStock calculado.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const Variant = require('./variant.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_variant_model';

describe('Variant (modelo)', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Variant.init(); // el índice único tarda en construirse
  });

  afterAll(async () => {
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    producto = await Product.create({ business: business._id, sku: 'REMERA-001', name: 'Remera básica', hasVariants: true });
  });

  test('crea una variante con atributos, scoped al negocio y al producto', async () => {
    const variante = await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M',
      attributes: { color: 'Rojo', talla: 'M' }, physicalStock: 10,
    });

    expect(variante.business.toString()).toBe(business._id.toString());
    expect(variante.product.toString()).toBe(producto._id.toString());
    expect(variante.attributes.get('color')).toBe('Rojo');
    expect(variante.attributes.get('talla')).toBe('M');
  });

  test('{business, sku} único: no se puede crear 2 variantes con el mismo SKU en el mismo negocio', async () => {
    await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo' } });

    await expect(
      Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: { color: 'Azul' } })
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  test('el mismo SKU SÍ puede existir en 2 negocios distintos', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    const otroProducto = await Product.create({ business: otroBusiness._id, sku: 'X', name: 'X', hasVariants: true });

    await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: {} });
    const variante = await Variant.create({ business: otroBusiness._id, product: otroProducto._id, sku: 'REMERA-001-ROJO-M', attributes: {} });

    expect(variante.sku).toBe('REMERA-001-ROJO-M');
  });

  test('availableStock se calcula (physicalStock - reservedStock), no se puede escribir directamente', async () => {
    const variante = await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: {},
      physicalStock: 20, reservedStock: 5, availableStock: 999,
    });

    expect(variante.availableStock).toBe(15);
    expect(variante.toObject().availableStock).toBe(15);
  });

  test('reservedStock no puede ser mayor que physicalStock', async () => {
    const variante = new Variant({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: {},
      physicalStock: 5, reservedStock: 10,
    });

    await expect(variante.validate()).rejects.toThrow(/stock reservado no puede ser mayor/);
  });

  test('price/currency por default quedan en null (cae al del Product padre en tiempo de lectura)', async () => {
    const variante = await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: {} });
    expect(variante.price).toBeNull();
    expect(variante.currency).toBeNull();
  });

  test('active por default es true, y no crea una variante sin business/product/sku', async () => {
    const variante = await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: {} });
    expect(variante.active).toBe(true);

    await expect(Variant.create({ product: producto._id, sku: 'X', attributes: {} })).rejects.toThrow();
    await expect(Variant.create({ business: business._id, sku: 'X', attributes: {} })).rejects.toThrow();
    await expect(Variant.create({ business: business._id, product: producto._id, attributes: {} })).rejects.toThrow();
  });
});
