// Test real (Jest, Mongo real — SIN mockear product.service.js) de
// priceStockGuard.service.js con datos REALES de variante — Fase 2, punto 6
// del Bloque 4 de la auditoría Business Brain (§59-61, 20/sep/2026):
// "confirmar que priceStockGuard.service.js sigue funcionando correctamente
// una vez que existen variantes". priceStockGuard.service.test.js (Bloque 3)
// ya cubre la lógica de la barrera mockeando product.service.js por
// completo — ese archivo nunca ejercita el buscarProductos() REAL, así que
// nunca hubiera detectado si el Bloque 4 (que le agregó las keys
// hasVariants/variants a cada resultado, ver product.service.js#buscarProductos())
// rompió algo en la integración real. Este archivo SÍ usa el
// buscarProductos() real, contra un producto con variantes de verdad.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('../products/product.model');
const Variant = require('../products/variant.model');
const { descartarClaimsDePrecioStockDesactualizados } = require('./priceStockGuard.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_price_stock_guard_variants';

describe('priceStockGuard.service — con datos reales de variante (Fase 2, punto 6)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init(); // el índice de texto tarda en construirse
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
  });

  test('chunk que menciona un producto CON variantes por su nombre + un precio: se DESCARTA (matchea vía buscarProductos real, aunque el resultado ahora traiga hasVariants/variants)', async () => {
    const producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera Premium', hasVariants: true, active: true,
    });
    await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M',
      attributes: { color: 'Rojo', talla: 'M' }, price: 50, physicalStock: 10,
    });

    const chunks = [{ text: 'La Remera Premium cuesta $80 en nuestra tienda física.', page: 2, score: 0.9 }];

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, business._id.toString());

    expect(resultado).toEqual([]);
  });

  test('chunk que menciona el nombre del producto + "stock"/"disponible" (sin precio): también se descarta', async () => {
    const producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera Premium', hasVariants: true, active: true,
    });
    await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-AZUL-L',
      attributes: { color: 'Azul', talla: 'L' }, physicalStock: 3,
    });

    const chunks = [{ text: 'Remera Premium: tenemos stock disponible en todos los talles.', page: 5, score: 0.85 }];

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, business._id.toString());

    expect(resultado).toEqual([]);
  });

  test('chunk que menciona precio de un producto DISTINTO (sin relación real, ni siquiera con variantes): se conserva', async () => {
    await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera Premium', hasVariants: true, active: true,
    });

    const chunks = [{ text: 'El envío a domicilio cuesta S/. 10 adicionales.', page: 1, score: 0.7 }];

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, business._id.toString());

    expect(resultado).toEqual(chunks);
  });

  test('producto CON variantes pero INACTIVO: buscarProductos real no lo trae (active:true es un filtro del propio buscarProductos) — el chunk se conserva', async () => {
    const producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera Premium Exclusiva', hasVariants: true, active: false,
    });
    await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo' }, physicalStock: 5,
    });

    const chunks = [{ text: 'Remera Premium Exclusiva: cuesta $99.', page: 3, score: 0.8 }];

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, business._id.toString());

    expect(resultado).toEqual(chunks);
  });

  test('un negocio con MUCHAS variantes del mismo producto sigue descartando UNA sola vez por chunk (buscarProductos no explota con hasVariants)', async () => {
    const producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera Premium', hasVariants: true, active: true,
    });
    await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-A', attributes: { color: 'Rojo', talla: 'S' }, physicalStock: 1 });
    await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-B', attributes: { color: 'Rojo', talla: 'M' }, physicalStock: 2 });
    await Variant.create({ business: business._id, product: producto._id, sku: 'REMERA-001-C', attributes: { color: 'Azul', talla: 'L' }, physicalStock: 3 });

    const chunks = [{ text: 'Remera Premium: precio especial de lanzamiento $60.', page: 4, score: 0.9 }];

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, business._id.toString());

    expect(resultado).toEqual([]);
  });
});
