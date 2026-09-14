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

  const crearSubscripcionConLimite = async (maxUsers, planName = 'starter') => {
    const plan = await Plan.create({
      name: planName,
      displayName: 'Plan de prueba',
      price: 0,
      limits: { maxUsers, multiUser: maxUsers > 1 },
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

  test.each(['starter', 'closer', 'dominator'])('%s rechaza un segundo usuario con 403', async (planName) => {
    await crearSubscripcionConLimite(1, planName);
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

// Gap de normalización (testers reales vía Play Console, sep/2026): antes de
// este fix, inviteUser() usaba req.body.email crudo — un email con mayúsculas/
// espacios no matcheaba el findOne() de deduplicación (podía colisionar con el
// índice único de Mongoose recién al hacer create(), con un error feo en vez
// del 409 controlado) ni matchearía después contra un login con otra variante
// de la misma dirección. Estos tests llaman a inviteUser() DIRECTO (sin pasar
// por Express) — a propósito, así prueban la normalización defensiva del
// propio controller (admin.controller.js), no la del middleware de la ruta
// (body('email')...normalizeEmail(), admin.routes.js, que acá ni corre).
describe('admin.controller#inviteUser() — normalización de email', () => {
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
    await Plan.create({ name: 'starter', displayName: 'Plan de prueba', price: 0, limits: { maxUsers: 10 } })
      .then((plan) => Subscription.create({ business: business._id, plan: plan._id, planName: plan.name, status: 'active', provider: 'free' }));
  });

  test('email con mayúsculas y espacios se guarda normalizado (trim + lowercase)', async () => {
    const req = {
      businessId: business._id,
      user: requester,
      body: { name: 'Nuevo Vendedor', email: '  Nuevo@Test.com  ', roleSlug: 'sales' },
    };
    const res = mockRes();
    const next = jest.fn();

    await inviteUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const creado = await User.findOne({ business: business._id });
    expect(creado.email).toBe('nuevo@test.com');
  });

  test('una variante de mayúsculas/espacios de un email YA invitado se rechaza como duplicado (409), no crea un segundo usuario', async () => {
    await User.create({
      business: business._id,
      name: 'Ya invitado',
      email: 'existente@test.com',
      password: 'hash-de-prueba',
      role: roleSales._id,
      isActive: true,
    });

    const req = {
      businessId: business._id,
      user: requester,
      body: { name: 'Variante del mismo email', email: '  Existente@Test.com  ', roleSlug: 'sales' },
    };
    const res = mockRes();
    const next = jest.fn();

    await inviteUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const errorPasado = next.mock.calls[0][0];
    expect(errorPasado.statusCode).toBe(409);
    expect(errorPasado.message).toMatch(/ya está registrado/i);
    expect(await User.countDocuments({ business: business._id })).toBe(1);
  });
});
