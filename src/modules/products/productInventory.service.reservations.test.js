// Test real (Jest, Mongo real) de las reservas de stock —
// productInventory.service.js#reservarStock/confirmarReserva/liberarReserva/
// liberarReservasVencidas. Bloque 4 de la auditoría Business Brain (§59,
// 20/sep/2026), ampliación consciente de alcance respecto al documento
// maestro original (§42, V1.5 "reservas" pospuestas). Mongo local en test
// corre standalone (sin replica set) — cada operación transaccional cae a
// su fallback secuencial (mismo camino que
// pdfIngestion.service.test.js#ejecutarCutover ya ejercita), así que estos
// tests validan el resultado final observable, no la mecánica interna de
// session.withTransaction().
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const Variant = require('./variant.model');
const StockReservation = require('./stockReservation.model');
const {
  reservarStock,
  confirmarReserva,
  liberarReserva,
  liberarReservasVencidas,
} = require('./productInventory.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_inventory_reservations';

describe('productInventory.service — reservas de stock (§59)', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await StockReservation.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await StockReservation.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera básica', physicalStock: 10, trackInventory: true,
    });
  });

  describe('reservarStock', () => {
    test('aparta stock (reservedStock sube, physicalStock queda igual) y crea la reserva "active"', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4 });

      expect(reserva.status).toBe('active');
      expect(reserva.quantity).toBe(4);

      const releido = await Product.findById(producto._id);
      expect(releido.physicalStock).toBe(10);
      expect(releido.reservedStock).toBe(4);
      expect(releido.availableStock).toBe(6);
    });

    test('stock insuficiente: 409, no crea la reserva ni toca reservedStock', async () => {
      await expect(reservarStock(business._id, { productId: producto._id, quantity: 11 })).rejects.toMatchObject({ statusCode: 409 });

      expect(await StockReservation.countDocuments({ product: producto._id })).toBe(0);
      const releido = await Product.findById(producto._id);
      expect(releido.reservedStock).toBe(0);
    });

    test('2 reservas seguidas que juntas exceden el stock: la segunda falla, la primera queda en pie', async () => {
      await reservarStock(business._id, { productId: producto._id, quantity: 7 });
      await expect(reservarStock(business._id, { productId: producto._id, quantity: 5 })).rejects.toMatchObject({ statusCode: 409 });

      const releido = await Product.findById(producto._id);
      expect(releido.reservedStock).toBe(7);
      expect(await StockReservation.countDocuments({ product: producto._id, status: 'active' })).toBe(1);
    });

    test('quantity inválida (0, negativa, no entera): 400, sin tocar stock', async () => {
      await expect(reservarStock(business._id, { productId: producto._id, quantity: 0 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(reservarStock(business._id, { productId: producto._id, quantity: -1 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(reservarStock(business._id, { productId: producto._id, quantity: 1.5 })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('producto sin control de inventario (trackInventory:false): 400', async () => {
      const servicio = await Product.create({
        business: business._id, sku: 'CONSULTORIA', name: 'Consultoría', trackInventory: false,
      });

      await expect(reservarStock(business._id, { productId: servicio._id, quantity: 1 })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('producto con variantes sin variantId: 400 (se requiere aclarar cuál)', async () => {
      const conVariantes = await Product.create({
        business: business._id, sku: 'REMERA-002', name: 'Remera premium', hasVariants: true,
      });
      await Variant.create({
        business: business._id, product: conVariantes._id, sku: 'REMERA-002-ROJO-M', attributes: { color: 'Rojo' }, physicalStock: 5,
      });

      await expect(reservarStock(business._id, { productId: conVariantes._id, quantity: 1 })).rejects.toMatchObject({ statusCode: 400 });
    });

    test('producto con variantes + variantId: aparta stock de la VARIANTE, el Product padre no se toca', async () => {
      const conVariantes = await Product.create({
        business: business._id, sku: 'REMERA-002', name: 'Remera premium', hasVariants: true,
      });
      const variante = await Variant.create({
        business: business._id, product: conVariantes._id, sku: 'REMERA-002-ROJO-M', attributes: { color: 'Rojo' }, physicalStock: 5,
      });

      const reserva = await reservarStock(business._id, { productId: conVariantes._id, variantId: variante._id, quantity: 2 });

      expect(reserva.variant.toString()).toBe(variante._id.toString());
      const varianteReleida = await Variant.findById(variante._id);
      expect(varianteReleida.reservedStock).toBe(2);
      const padreReleido = await Product.findById(conVariantes._id);
      expect(padreReleido.reservedStock).toBe(0);
    });

    test('variantId de otro producto/negocio: 404, nunca confía en un id cruzado', async () => {
      const conVariantes = await Product.create({
        business: business._id, sku: 'REMERA-002', name: 'Remera premium', hasVariants: true,
      });
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const otroProducto = await Product.create({ business: otroBusiness._id, sku: 'X', name: 'X', hasVariants: true });
      const varianteAjena = await Variant.create({
        business: otroBusiness._id, product: otroProducto._id, sku: 'X-ROJO', attributes: { color: 'Rojo' }, physicalStock: 5,
      });

      await expect(
        reservarStock(business._id, { productId: conVariantes._id, variantId: varianteAjena._id, quantity: 1 })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test('guarda leadId/createdBy cuando se pasan', async () => {
      const leadId = new mongoose.Types.ObjectId();
      const userId = new mongoose.Types.ObjectId();

      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 1, leadId, createdBy: userId });

      expect(reserva.lead.toString()).toBe(leadId.toString());
      expect(reserva.createdBy.toString()).toBe(userId.toString());
    });
  });

  describe('confirmarReserva', () => {
    test('venta real: descuenta physicalStock Y reservedStock, marca confirmed', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4 });

      const confirmada = await confirmarReserva(business._id, reserva._id);

      expect(confirmada.status).toBe('confirmed');
      expect(confirmada.confirmedAt).not.toBeNull();

      const releido = await Product.findById(producto._id);
      expect(releido.physicalStock).toBe(6);
      expect(releido.reservedStock).toBe(0);
      expect(releido.availableStock).toBe(6);
    });

    test('confirmar 2 veces la MISMA reserva: idempotente, no descuenta physicalStock de nuevo', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4 });

      await confirmarReserva(business._id, reserva._id);
      const segundaVez = await confirmarReserva(business._id, reserva._id);

      expect(segundaVez.status).toBe('confirmed');
      const releido = await Product.findById(producto._id);
      expect(releido.physicalStock).toBe(6); // no 2 — un solo descuento real
      expect(releido.reservedStock).toBe(0);
    });

    test('confirmar una reserva YA liberada: 409 (conflicto real, no idempotente)', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4 });
      await liberarReserva(business._id, reserva._id);

      await expect(confirmarReserva(business._id, reserva._id)).rejects.toMatchObject({ statusCode: 409 });
    });

    test('reserva inexistente: 404', async () => {
      await expect(confirmarReserva(business._id, new mongoose.Types.ObjectId())).rejects.toMatchObject({ statusCode: 404 });
    });

    test('reserva de OTRO negocio: 404 (nunca confía en un id cruzado)', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 1 });
      const otroBusiness = await Business.create({ name: 'Otro negocio' });

      await expect(confirmarReserva(otroBusiness._id, reserva._id)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('liberarReserva', () => {
    test('el lead no confirmó: devuelve el stock apartado, physicalStock nunca se toca', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4 });

      const liberada = await liberarReserva(business._id, reserva._id);

      expect(liberada.status).toBe('released');
      expect(liberada.releasedAt).not.toBeNull();
      const releido = await Product.findById(producto._id);
      expect(releido.physicalStock).toBe(10);
      expect(releido.reservedStock).toBe(0);
    });

    test('liberar 2 veces la MISMA reserva: idempotente', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4 });

      await liberarReserva(business._id, reserva._id);
      const segundaVez = await liberarReserva(business._id, reserva._id);

      expect(segundaVez.status).toBe('released');
      const releido = await Product.findById(producto._id);
      expect(releido.reservedStock).toBe(0);
    });
  });

  describe('liberarReservasVencidas (sweep)', () => {
    test('reserva vence SIN confirmarse: se marca expired, reservedStock baja, physicalStock queda igual', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 3 });
      await StockReservation.updateOne({ _id: reserva._id }, { expiresAt: new Date(Date.now() - 60 * 1000) });

      const resultado = await liberarReservasVencidas();

      expect(resultado.totalVencidas).toBe(1);
      expect(resultado.totalLiberadas).toBe(1);

      const releida = await StockReservation.findById(reserva._id);
      expect(releida.status).toBe('expired');
      expect(releida.releasedAt).not.toBeNull();

      const releido = await Product.findById(producto._id);
      expect(releido.physicalStock).toBe(10);
      expect(releido.reservedStock).toBe(0);
    });

    test('reserva que TODAVÍA no vence: el barrido no la toca', async () => {
      await reservarStock(business._id, { productId: producto._id, quantity: 3 });

      const resultado = await liberarReservasVencidas();

      expect(resultado.totalVencidas).toBe(0);
      const releido = await Product.findById(producto._id);
      expect(releido.reservedStock).toBe(3);
    });

    test('reserva ya confirmada/liberada antes del vencimiento: el barrido no la re-toca aunque expiresAt ya haya pasado', async () => {
      const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 3 });
      await confirmarReserva(business._id, reserva._id);
      await StockReservation.updateOne({ _id: reserva._id }, { expiresAt: new Date(Date.now() - 60 * 1000) });

      const resultado = await liberarReservasVencidas();

      expect(resultado.totalVencidas).toBe(0); // el find() del barrido solo mira status:'active'
      const releida = await StockReservation.findById(reserva._id);
      expect(releida.status).toBe('confirmed'); // no se pisa
    });

    test('reserva de una VARIANTE que vence: libera el reservedStock de la variante, no del Product padre', async () => {
      const conVariantes = await Product.create({
        business: business._id, sku: 'REMERA-002', name: 'Remera premium', hasVariants: true,
      });
      const variante = await Variant.create({
        business: business._id, product: conVariantes._id, sku: 'REMERA-002-ROJO-M', attributes: { color: 'Rojo' }, physicalStock: 5,
      });
      const reserva = await reservarStock(business._id, { productId: conVariantes._id, variantId: variante._id, quantity: 2 });
      await StockReservation.updateOne({ _id: reserva._id }, { expiresAt: new Date(Date.now() - 60 * 1000) });

      await liberarReservasVencidas();

      const varianteReleida = await Variant.findById(variante._id);
      expect(varianteReleida.reservedStock).toBe(0);
    });
  });
});
