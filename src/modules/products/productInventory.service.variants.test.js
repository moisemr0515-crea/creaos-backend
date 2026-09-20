// Test real (Jest, Mongo real) de crearVariante/listarVariantes/
// actualizarVariante/desactivarVariante — Bloque 4 de la auditoría
// Business Brain (§61, 20/sep/2026).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const Variant = require('./variant.model');
const {
  crearVariante,
  listarVariantes,
  obtenerVariante,
  actualizarVariante,
  desactivarVariante,
} = require('./productInventory.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_inventory_service';

describe('productInventory.service — variantes', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
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
    business = await Business.create({ name: 'Negocio de prueba' });
    producto = await Product.create({ business: business._id, sku: 'REMERA-001', name: 'Remera básica' });
  });

  describe('crearVariante', () => {
    test('crea la variante y marca hasVariants:true en el producto automáticamente', async () => {
      expect(producto.hasVariants).toBe(false);

      const variante = await crearVariante(business._id, producto._id, {
        sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo', talla: 'M' }, physicalStock: 10,
      });

      expect(variante.sku).toBe('REMERA-001-ROJO-M');
      const productoActualizado = await Product.findById(producto._id);
      expect(productoActualizado.hasVariants).toBe(true);
    });

    test('la SEGUNDA variante no vuelve a tocar hasVariants (ya estaba true)', async () => {
      await crearVariante(business._id, producto._id, { sku: 'A', attributes: { color: 'Rojo' } });
      const variante2 = await crearVariante(business._id, producto._id, { sku: 'B', attributes: { color: 'Azul' } });

      expect(variante2.sku).toBe('B');
    });

    test('rechaza una variante sin ningún atributo', async () => {
      await expect(
        crearVariante(business._id, producto._id, { sku: 'REMERA-001-X', attributes: {} })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('rechaza un SKU duplicado en el mismo negocio', async () => {
      await crearVariante(business._id, producto._id, { sku: 'REMERA-001-ROJO-M', attributes: { color: 'Rojo' } });

      await expect(
        crearVariante(business._id, producto._id, { sku: 'REMERA-001-ROJO-M', attributes: { color: 'Azul' } })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    test('producto de OTRO negocio: 404, nunca crea la variante', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });

      await expect(
        crearVariante(otroBusiness._id, producto._id, { sku: 'X', attributes: { color: 'Rojo' } })
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('listarVariantes / obtenerVariante', () => {
    test('lista TODAS las variantes (activas e inactivas) — vista de administración', async () => {
      const v1 = await crearVariante(business._id, producto._id, { sku: 'A', attributes: { color: 'Rojo' } });
      await desactivarVariante(business._id, producto._id, v1._id);
      await crearVariante(business._id, producto._id, { sku: 'B', attributes: { color: 'Azul' } });

      const variantes = await listarVariantes(business._id, producto._id);

      expect(variantes).toHaveLength(2);
    });

    test('no encuentra una variante de OTRO negocio (aislamiento por tenant)', async () => {
      const variante = await crearVariante(business._id, producto._id, { sku: 'A', attributes: { color: 'Rojo' } });
      const otroBusiness = await Business.create({ name: 'Otro negocio' });

      await expect(obtenerVariante(otroBusiness._id, producto._id, variante._id)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('actualizarVariante', () => {
    test('actualiza precio/stock de una variante puntual', async () => {
      const variante = await crearVariante(business._id, producto._id, { sku: 'A', attributes: { color: 'Rojo' } });

      const actualizada = await actualizarVariante(business._id, producto._id, variante._id, { price: 45, physicalStock: 20 });

      expect(actualizada.price).toBe(45);
      expect(actualizada.physicalStock).toBe(20);
    });

    test('valida SKU duplicado al cambiarlo', async () => {
      await crearVariante(business._id, producto._id, { sku: 'A', attributes: { color: 'Rojo' } });
      const b = await crearVariante(business._id, producto._id, { sku: 'B', attributes: { color: 'Azul' } });

      await expect(actualizarVariante(business._id, producto._id, b._id, { sku: 'A' })).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('desactivarVariante', () => {
    test('nunca borra — solo pone active:false', async () => {
      const variante = await crearVariante(business._id, producto._id, { sku: 'A', attributes: { color: 'Rojo' } });

      await desactivarVariante(business._id, producto._id, variante._id);

      const releida = await Variant.findById(variante._id);
      expect(releida).not.toBeNull();
      expect(releida.active).toBe(false);
    });
  });
});
