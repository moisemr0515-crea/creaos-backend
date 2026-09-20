// Test real (Jest, Mongo real) del modelo StockReservation — Bloque 4 de la
// auditoría Business Brain (§59, 20/sep/2026). Cubre lo que vive en el
// esquema mismo: campos requeridos, enum de status, default 'active'.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const StockReservation = require('./stockReservation.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_stock_reservation_model';

describe('StockReservation (modelo)', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await StockReservation.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await StockReservation.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    producto = await Product.create({ business: business._id, sku: 'REMERA-001', name: 'Remera básica', physicalStock: 10 });
  });

  test('crea una reserva activa con los defaults esperados', async () => {
    const reserva = await StockReservation.create({
      business: business._id,
      product: producto._id,
      quantity: 3,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    expect(reserva.status).toBe('active');
    expect(reserva.variant).toBeNull();
    expect(reserva.lead).toBeNull();
    expect(reserva.confirmedAt).toBeNull();
    expect(reserva.releasedAt).toBeNull();
  });

  test('exige business, product, quantity y expiresAt', async () => {
    await expect(StockReservation.create({ product: producto._id, quantity: 1, expiresAt: new Date() })).rejects.toThrow();
    await expect(StockReservation.create({ business: business._id, quantity: 1, expiresAt: new Date() })).rejects.toThrow();
    await expect(StockReservation.create({ business: business._id, product: producto._id, expiresAt: new Date() })).rejects.toThrow();
    await expect(StockReservation.create({ business: business._id, product: producto._id, quantity: 1 })).rejects.toThrow();
  });

  test('quantity debe ser al menos 1', async () => {
    await expect(
      StockReservation.create({ business: business._id, product: producto._id, quantity: 0, expiresAt: new Date() })
    ).rejects.toThrow();
  });

  test('status solo acepta los 4 valores del ciclo de vida', async () => {
    await expect(
      StockReservation.create({
        business: business._id, product: producto._id, quantity: 1, expiresAt: new Date(), status: 'pending',
      })
    ).rejects.toThrow();
  });
});
