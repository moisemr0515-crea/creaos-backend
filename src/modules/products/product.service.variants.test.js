// Test real (Jest, Mongo real) de consultarStock()/consultarPrecio()/
// buscarProductos() variant-aware — Bloque 4 de la auditoría Business
// Brain (§61, 20/sep/2026). Cubre que los 3 mantienen EXACTAMENTE el
// comportamiento de siempre para productos sin variantes (product.service.test.js
// ya lo prueba, sin cambios) y agregan el camino nuevo sin duplicar la
// ramificación hasVariants/variantId en cada función.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const Variant = require('./variant.model');
const { consultarStock, consultarPrecio, buscarProductos } = require('./product.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_service_variants';

describe('product.service — variant-aware (Bloque 4, §61)', () => {
  let business;
  let producto;
  let varianteRoja;
  let varianteAzul;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await Product.init();
    await Variant.init();
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
    business = await Business.create({ name: 'Negocio de prueba', currency: 'PEN' });
    producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera básica', hasVariants: true, price: 40,
    });
    varianteRoja = await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-ROJO-M',
      attributes: { color: 'Rojo', talla: 'M' }, price: 45, physicalStock: 10, reservedStock: 2, minimumStock: 3,
    });
    varianteAzul = await Variant.create({
      business: business._id, product: producto._id, sku: 'REMERA-001-AZUL-L',
      attributes: { color: 'Azul', talla: 'L' }, physicalStock: 0, // sin price propio -> cae al del Product
    });
  });

  describe('consultarStock()', () => {
    test('producto con variantes, SIN variantId: needsVariantSelection:true, con las variantes activas', async () => {
      const resultado = await consultarStock(business._id, producto._id);

      expect(resultado).toEqual({
        productId: producto._id,
        needsVariantSelection: true,
        variants: expect.arrayContaining([
          expect.objectContaining({ sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo', talla: 'M' }, availableStock: 8 }),
          expect.objectContaining({ sku: 'REMERA-001-AZUL-L', attributes: { color: 'Azul', talla: 'L' }, availableStock: 0 }),
        ]),
      });
    });

    test('producto con variantes, CON variantId: devuelve el stock de ESA variante puntual', async () => {
      const resultado = await consultarStock(business._id, producto._id, varianteRoja._id);

      expect(resultado).toEqual({
        productId: producto._id,
        variantId: varianteRoja._id,
        trackInventory: true,
        physicalStock: 10,
        reservedStock: 2,
        availableStock: 8,
        inStock: true,
        lowStock: false,
      });
    });

    test('lowStock se calcula sobre el minimumStock de LA VARIANTE, no del producto padre', async () => {
      const varianteBaja = await Variant.create({
        business: business._id, product: producto._id, sku: 'REMERA-001-VERDE-S',
        attributes: { color: 'Verde' }, physicalStock: 2, minimumStock: 5,
      });

      const resultado = await consultarStock(business._id, producto._id, varianteBaja._id);

      expect(resultado.lowStock).toBe(true);
    });

    test('variantId que no pertenece a este producto (o a otro negocio): 404, nunca expone stock ajeno', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const otroProducto = await Product.create({ business: otroBusiness._id, sku: 'X', name: 'X', hasVariants: true });
      const varianteAjena = await Variant.create({ business: otroBusiness._id, product: otroProducto._id, sku: 'AJENA', attributes: {} });

      await expect(consultarStock(business._id, producto._id, varianteAjena._id)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('producto SIN variantes: comportamiento idéntico a siempre, sin variantId en el resultado', async () => {
      const simple = await Product.create({ business: business._id, sku: 'SIMPLE-001', name: 'Producto simple', physicalStock: 5 });

      const resultado = await consultarStock(business._id, simple._id);

      expect(resultado).toEqual({
        productId: simple._id, trackInventory: true, physicalStock: 5, reservedStock: 0,
        availableStock: 5, inStock: true, lowStock: false,
      });
      expect(resultado.variantId).toBeUndefined();
    });
  });

  describe('consultarPrecio()', () => {
    test('producto con variantes, SIN variantId: needsVariantSelection:true', async () => {
      const resultado = await consultarPrecio(business._id, producto._id);
      expect(resultado.needsVariantSelection).toBe(true);
    });

    test('variante CON price propio: usa el de la variante, no el del producto padre', async () => {
      const resultado = await consultarPrecio(business._id, producto._id, varianteRoja._id);

      expect(resultado).toEqual({ productId: producto._id, variantId: varianteRoja._id, price: 45, currency: 'PEN', priceAvailable: true });
    });

    test('variante SIN price propio: cae al price del producto padre (mismo patrón de fallback que currency)', async () => {
      const resultado = await consultarPrecio(business._id, producto._id, varianteAzul._id);

      expect(resultado).toEqual({ productId: producto._id, variantId: varianteAzul._id, price: 40, currency: 'PEN', priceAvailable: true });
    });
  });

  describe('buscarProductos()', () => {
    test('un producto CON variantes trae hasVariants:true y el array de variantes activas', async () => {
      const resultados = await buscarProductos(business._id, 'remera');

      expect(resultados[0].hasVariants).toBe(true);
      expect(resultados[0].variants).toHaveLength(2);
      expect(resultados[0].variants.map((v) => v.sku).sort()).toEqual(['REMERA-001-AZUL-L', 'REMERA-001-ROJO-M']);
    });

    test('un producto SIN variantes: sin la clave hasVariants ni variants, comportamiento idéntico a siempre', async () => {
      await Product.create({ business: business._id, sku: 'SIMPLE-002', name: 'Buzo simple', price: 60 });

      const resultados = await buscarProductos(business._id, 'buzo');

      expect(resultados[0].hasVariants).toBeUndefined();
      expect(resultados[0].variants).toBeUndefined();
    });

    test('variantes desactivadas NUNCA aparecen en el array de selección', async () => {
      await Variant.findByIdAndUpdate(varianteAzul._id, { active: false });

      const resultados = await buscarProductos(business._id, 'remera');

      expect(resultados[0].variants.map((v) => v.sku)).toEqual(['REMERA-001-ROJO-M']);
    });
  });
});
