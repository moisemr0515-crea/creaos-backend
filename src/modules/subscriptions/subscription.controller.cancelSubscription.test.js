// Test real (Jest, commiteado) de subscription.controller.js#cancelSubscription()
// — regresión del incidente del 12/sep/2026: un bug de UX en el frontend
// (crea-os-ignite/src/routes/plan.tsx) hizo que un solo click en la tarjeta
// de un plan distinto al actual disparara este endpoint sin ningún paso
// intermedio, cancelando la suscripción real de un negocio (CREA OS). El
// frontend ya agregó un modal de confirmación (ver plan.tsx), pero este
// archivo prueba la segunda barrera, en el backend: el endpoint debe
// rechazar la cancelación si el body no trae `confirm: true` explícito —
// así ninguna llamada HTTP accidental o mal formada, de este frontend o de
// cualquier otro cliente futuro, puede cancelar sin intención clara.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const { cancelSubscription } = require('./subscription.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_subscription_cancel';

// Mock mínimo de Response — solo lo que respuestaExito() realmente usa
// (status().json()), encadenable como el real. Igual patrón que
// admin.controller.inviteUser.test.js.
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('subscription.controller#cancelSubscription() — exige confirm:true explícito', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearSubscripcionActiva = async () => {
    const plan = await Plan.create({
      name: 'closer',
      displayName: 'Plan de prueba',
      price: 999,
      limits: {},
    });
    return Subscription.create({
      business: business._id,
      plan: plan._id,
      planName: plan.name,
      status: 'active',
      provider: 'free',
    });
  };

  test('rechaza con 400 si el body NO trae confirm:true — y no toca la suscripción real', async () => {
    const sub = await crearSubscripcionActiva();
    const req = { businessId: business._id, body: {} };
    const res = mockRes();
    const next = jest.fn();

    await cancelSubscription(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(res.json).not.toHaveBeenCalled();

    // Regresión clave del incidente: la suscripción real NO debe cambiar de
    // estado cuando falta la confirmación explícita.
    const sinTocar = await Subscription.findById(sub._id);
    expect(sinTocar.status).toBe('active');
  });

  test('rechaza con 400 si confirm viene en false o con un valor "truthy" que no sea exactamente true', async () => {
    await crearSubscripcionActiva();
    const res = mockRes();

    for (const valorInvalido of [false, 'true', 1, undefined]) {
      const next = jest.fn();
      await cancelSubscription(
        { businessId: business._id, body: { confirm: valorInvalido } },
        res,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0].statusCode).toBe(400);
    }
  });

  test('acepta y cancela la suscripción real cuando confirm:true viene explícito', async () => {
    const sub = await crearSubscripcionActiva();
    const req = { businessId: business._id, body: { confirm: true } };
    const res = mockRes();
    const next = jest.fn();

    await cancelSubscription(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalled();

    const cancelada = await Subscription.findById(sub._id);
    expect(cancelada.status).toBe('canceled');
  });
});
