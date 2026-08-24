// Test real (Jest, commiteado) de admin.controller.js#inviteUser() — el
// punto de enforcement real de Plan.limits.maxUsers (auditoría de pricing
// del 23/ago/2026, Track 1 #3). No solo se testea checkUserLimit() en
// aislamiento (ver subscription.service.checkUserLimit.test.js) — este
// archivo prueba el wiring real del controller, para no depender de que
// "seguro está bien conectado" quede sin verificar.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('../subscriptions/plan.model');
const Subscription = require('../subscriptions/subscription.model');
const User = require('../users/user.model');
const Role = require('../roles/role.model');
const { inviteUser } = require('./admin.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_admin_inviteuser';

// Mock mínimo de Response — solo lo que respuestaExito()/respuestaError()
// realmente usan (status().json()), encadenable como el real.
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('admin.controller#inviteUser() — bloqueo duro de plan', () => {
  let business;
  let roleSales;
  const requester = { _id: new mongoose.Types.ObjectId(), role: { slug: 'owner' } };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    roleSales = await Role.findOneAndUpdate(
      { slug: 'sales', business: null },
      { name: 'Sales', slug: 'sales', business: null, isSystem: true, permissions: [] },
      { upsert: true, new: true }
    );
  });

  afterAll(async () => {
    await User.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    await Role.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearSubscripcionConLimite = async (maxUsers) => {
    const plan = await Plan.create({
      name: 'starter',
      displayName: 'Plan de prueba',
      price: 0,
      limits: { maxUsers },
    });
    await Subscription.create({
      business: business._id,
      plan: plan._id,
      planName: plan.name,
      status: 'active',
      provider: 'free',
    });
  };

  const crearUsuario = () =>
    User.create({
      business: business._id,
      name: 'Usuario existente',
      email: `existente-${new mongoose.Types.ObjectId()}@test.com`,
      password: 'hash-de-prueba',
      role: roleSales._id,
      isActive: true,
    });

  test('invita normalmente cuando el negocio está bajo el límite', async () => {
    await crearSubscripcionConLimite(3);
    const req = {
      businessId: business._id,
      user: requester,
      body: { name: 'Nuevo Vendedor', email: 'nuevo@test.com', roleSlug: 'sales' },
    };
    const res = mockRes();
    const next = jest.fn();

    await inviteUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(await User.countDocuments({ business: business._id })).toBe(1);
  });

  test('rechaza con 403 cuando el negocio ya está en el límite — NO crea el usuario', async () => {
    await crearSubscripcionConLimite(1);
    await crearUsuario();

    const req = {
      businessId: business._id,
      user: requester,
      body: { name: 'No debería entrar', email: 'rechazado@test.com', roleSlug: 'sales' },
    };
    const res = mockRes();
    const next = jest.fn();

    await inviteUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const errorPasado = next.mock.calls[0][0];
    expect(errorPasado.statusCode).toBe(403);
    expect(errorPasado.message).toMatch(/límite de usuarios/i);

    // El único usuario sigue siendo el que ya existía — nada nuevo se creó.
    expect(await User.countDocuments({ business: business._id })).toBe(1);
  });

  test('un usuario desactivado libera cupo para la próxima invitación', async () => {
    await crearSubscripcionConLimite(1);
    const existente = await crearUsuario();
    await User.updateOne({ _id: existente._id }, { $set: { isActive: false } });

    const req = {
      businessId: business._id,
      user: requester,
      body: { name: 'Reemplazo', email: 'reemplazo@test.com', roleSlug: 'sales' },
    };
    const res = mockRes();
    const next = jest.fn();

    await inviteUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
