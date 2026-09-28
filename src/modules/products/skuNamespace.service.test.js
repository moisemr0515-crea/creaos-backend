const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const Variant = require('./variant.model');
const productService = require('./product.service');
const inventoryService = require('./productInventory.service');
const { previsualizarImportacion, confirmarImportacion } = require('./productImport.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_sku_namespace';

describe('namespace SKU compartido Product/Variant', () => {
  let business;
  let otherBusiness;

  beforeAll(async () => mongoose.connect(MONGO_URI));
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
    business = await Business.create({ name: 'Tenant A' });
    otherBusiness = await Business.create({ name: 'Tenant B' });
  });

  test('Product X bloquea Variant X; Variant Y bloquea Product Y en el mismo tenant', async () => {
    const parent = await productService.crearProducto(business._id, null, { sku: 'PARENT', name: 'Parent' });
    await productService.crearProducto(business._id, null, { sku: 'X', name: 'Producto X' });
    await expect(inventoryService.crearVariante(business._id, parent._id, {
      sku: 'x', attributes: { color: 'Rojo' },
    })).rejects.toMatchObject({ statusCode: 409 });

    await inventoryService.crearVariante(business._id, parent._id, { sku: 'Y', attributes: { color: 'Azul' } });
    await expect(productService.crearProducto(business._id, null, { sku: 'y', name: 'Producto Y' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('el mismo SKU en otro tenant sigue permitido', async () => {
    await productService.crearProducto(business._id, null, { sku: 'SHARED', name: 'A' });
    await expect(productService.crearProducto(otherBusiness._id, null, { sku: 'SHARED', name: 'B' }))
      .resolves.toMatchObject({ sku: 'SHARED' });
  });

  test('actualizaciones de Product y Variant respetan el namespace cruzado', async () => {
    const parent = await productService.crearProducto(business._id, null, { sku: 'PARENT', name: 'Parent' });
    const product = await productService.crearProducto(business._id, null, { sku: 'PRODUCT', name: 'Product' });
    const variant = await inventoryService.crearVariante(business._id, parent._id, {
      sku: 'VARIANT', attributes: { talla: 'M' },
    });

    await expect(productService.actualizarProducto(business._id, product._id, null, { sku: 'VARIANT' }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(inventoryService.actualizarVariante(business._id, parent._id, variant._id, { sku: 'PRODUCT' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('preview y confirmación de import bloquean SKU reservado por Variant', async () => {
    const parent = await productService.crearProducto(business._id, null, { sku: 'PARENT', name: 'Parent' });
    await inventoryService.crearVariante(business._id, parent._id, { sku: 'VAR-CSV', attributes: { color: 'Negro' } });
    const file = { originalname: 'products.csv', buffer: Buffer.from('sku,nombre\nVAR-CSV,Colision') };

    const preview = await previsualizarImportacion(business._id, file);
    expect(preview.resumen.conErrores).toBe(1);
    expect(preview.filas[0].errores).toContain('SKU ya utilizado por una variante en este negocio');

    const result = await confirmarImportacion(business._id, null, file);
    expect(result.resumen.nuevos).toBe(0);
    expect(await Product.countDocuments({ business: business._id, sku: 'VAR-CSV' })).toBe(0);
  });
});
