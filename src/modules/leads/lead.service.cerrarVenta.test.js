// Test real (Jest, Mongo real) de lead.service.js#cerrarVenta() —
// POST /leads/:id/close-sale (Bloque 4 de la auditoría Business Brain,
// §59-60, 20/sep/2026). Reemplaza el flujo viejo de "Cerrar venta" (2
// llamadas HTTP separadas, sin productId) por una operación atómica +
// idempotente. Mongo local (standalone) no soporta transacciones — este
// suite ejercita la rama de fallback secuencial (mismo criterio EXACTO que
// pdfIngestion.service.test.js: la garantía de atomicidad real es de
// MongoDB en Atlas/replica set, no algo que este test pueda reproducir
// localmente; lo que SÍ cubre acá es la corrección funcional completa).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('./lead.model');
const Product = require('../products/product.model');
const Variant = require('../products/variant.model');
const StockReservation = require('../products/stockReservation.model');
const { reservarStock } = require('../products/productInventory.service');
const { cerrarVenta } = require('./lead.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_cerrar_venta';

describe('lead.service#cerrarVenta() — cierre de venta con productos (§59-60)', () => {
  let business;
  let pipeline;
  let lead;
  let producto;
  const actor = { _id: new mongoose.Types.ObjectId(), name: 'Actor de prueba' };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await StockReservation.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await StockReservation.deleteMany({});
    await Variant.deleteMany({});
    await Product.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});

    business = await Business.create({ name: 'Negocio de prueba' });
    pipeline = await Pipeline.createDefault(business._id, actor._id);
    lead = await Lead.create({
      business: business._id, name: 'Lead de prueba', pipeline: pipeline._id, pipelineStage: 'negotiating',
    });
    producto = await Product.create({
      business: business._id, sku: 'REMERA-001', name: 'Remera básica', physicalStock: 10, trackInventory: true,
    });
  });

  test('sin items: solo monto + etapa "ganado", mismo comportamiento que el flujo viejo', async () => {
    const cerrado = await cerrarVenta(business._id, lead._id, actor, { actualValue: 850, items: [] });

    expect(cerrado.actualValue).toBe(850);
    expect(cerrado.pipelineStage).toBe('won');
    expect(cerrado.saleClosedAt).not.toBeNull();
    expect(cerrado.closeProbability).toBe(100);

    const releido = await Lead.findById(lead._id);
    expect(releido.actualValue).toBe(850);
    expect(releido.pipelineStage).toBe('won');
  });

  test('con items SIN reservationId: descuenta physicalStock directo de cada producto', async () => {
    const cerrado = await cerrarVenta(business._id, lead._id, actor, {
      actualValue: 500,
      items: [{ productId: producto._id, quantity: 3 }],
    });

    expect(cerrado.pipelineStage).toBe('won');
    const productoReleido = await Product.findById(producto._id);
    expect(productoReleido.physicalStock).toBe(7);
    expect(productoReleido.reservedStock).toBe(0);
  });

  test('con items CON reservationId: confirma la reserva existente (descuenta physicalStock Y reservedStock)', async () => {
    const reserva = await reservarStock(business._id, { productId: producto._id, quantity: 4, leadId: lead._id });

    const cerrado = await cerrarVenta(business._id, lead._id, actor, {
      actualValue: 700,
      items: [{ productId: producto._id, quantity: 4, reservationId: reserva._id }],
    });

    expect(cerrado.pipelineStage).toBe('won');
    const productoReleido = await Product.findById(producto._id);
    expect(productoReleido.physicalStock).toBe(6);
    expect(productoReleido.reservedStock).toBe(0);

    const reservaReleida = await StockReservation.findById(reserva._id);
    expect(reservaReleida.status).toBe('confirmed');
  });

  test('cierra con variantes: descuenta la VARIANTE correcta, el Product padre no se toca', async () => {
    const conVariantes = await Product.create({
      business: business._id, sku: 'REMERA-002', name: 'Remera premium', hasVariants: true,
    });
    const variante = await Variant.create({
      business: business._id, product: conVariantes._id, sku: 'REMERA-002-ROJO-M', attributes: { color: 'Rojo' }, physicalStock: 5,
    });

    await cerrarVenta(business._id, lead._id, actor, {
      actualValue: 100,
      items: [{ productId: conVariantes._id, variantId: variante._id, quantity: 2 }],
    });

    const varianteReleida = await Variant.findById(variante._id);
    expect(varianteReleida.physicalStock).toBe(3);
    const padreReleido = await Product.findById(conVariantes._id);
    expect(padreReleido.physicalStock).toBe(0); // default, nunca tocado
  });

  test('IDEMPOTENTE: cerrar el mismo lead 2 veces no descuenta stock 2 veces ni pisa el monto', async () => {
    await cerrarVenta(business._id, lead._id, actor, {
      actualValue: 500,
      items: [{ productId: producto._id, quantity: 3 }],
    });

    const segundaVez = await cerrarVenta(business._id, lead._id, actor, {
      actualValue: 999, // distinto a propósito — no debería pisar el ya guardado
      items: [{ productId: producto._id, quantity: 3 }], // mismo item — si se re-procesara, dejaría el stock en 4, no en 7
    });

    expect(segundaVez.actualValue).toBe(500); // el de la PRIMERA vez, no 999
    const productoReleido = await Product.findById(producto._id);
    expect(productoReleido.physicalStock).toBe(7); // un solo descuento real, no 2
  });

  test('sin etapa "ganado" configurada en el Pipeline: 400, el lead no se toca', async () => {
    pipeline.stages = pipeline.stages.filter((s) => !s.isWon);
    await pipeline.save();

    await expect(cerrarVenta(business._id, lead._id, actor, { actualValue: 100, items: [] })).rejects.toMatchObject({ statusCode: 400 });

    const releido = await Lead.findById(lead._id);
    expect(releido.saleClosedAt).toBeNull();
    expect(releido.pipelineStage).toBe('negotiating');
  });

  test('lead inexistente: 404', async () => {
    await expect(cerrarVenta(business._id, new mongoose.Types.ObjectId(), actor, { actualValue: 100 })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('lead de OTRO negocio: 404 (nunca confía en un id cruzado)', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    await expect(cerrarVenta(otroBusiness._id, lead._id, actor, { actualValue: 100 })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('item con stock insuficiente: rechaza el cierre (409)', async () => {
    await expect(
      cerrarVenta(business._id, lead._id, actor, {
        actualValue: 100,
        items: [{ productId: producto._id, quantity: 999 }],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
