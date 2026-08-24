// Test real (Jest, commiteado) de subscription.service.js#checkUserLimit()
// — enforcement de Plan.limits.maxUsers (auditoría de pricing del
// 23/ago/2026, Track 1 #3). Archivo separado de
// subscription.service.test.js (que cubre checkLeadLimit/contarLeadsActivos)
// mismo criterio de "una preocupación por archivo" que ya usa el resto del
// repo (lead.service.test.js vs import.service.test.js).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const User = require('../users/user.model');
const Role = require('../roles/role.model');
const { checkUserLimit } = require('./subscription.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_subscription_userlimit';

describe('subscription.service#checkUserLimit()', () => {
  let business;
  let role;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    role = await Role.findOneAndUpdate(
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
    // name: 'starter' fijo — Plan.name tiene un enum estricto, beforeEach
    // ya limpia Plan entre tests.
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

  const crearUsuario = (overrides = {}) =>
    User.create({
      business: business._id,
      name: overrides.name || 'Usuario de prueba',
      email: overrides.email || `usuario-${new mongoose.Types.ObjectId()}@test.com`,
      password: 'hash-de-prueba',
      role: role._id,
      isActive: overrides.isActive ?? true,
    });

  test('allowed:true mientras los usuarios activos estén bajo el límite', async () => {
    await crearSubscripcionConLimite(3);
    await crearUsuario();

    const result = await checkUserLimit(business._id);
    expect(result).toEqual({ allowed: true, current: 1, limit: 3 });
  });

  test('allowed:false al llegar exactamente al límite', async () => {
    await crearSubscripcionConLimite(1);
    await crearUsuario();

    const result = await checkUserLimit(business._id);
    expect(result).toEqual({ allowed: false, current: 1, limit: 1 });
  });

  test('un usuario desactivado (isActive:false) no cuenta contra el límite', async () => {
    await crearSubscripcionConLimite(1);
    await crearUsuario({ isActive: false });
    // El único usuario del negocio está desactivado — hay cupo libre.
    const result = await checkUserLimit(business._id);
    expect(result).toEqual({ allowed: true, current: 0, limit: 1 });
  });

  test('sin Plan poblado (fallback), usa 1 — fail-closed al valor real de Starter', async () => {
    // Sin crear ninguna Subscription: getCurrentSubscription() auto-crea
    // con el plan 'starter' real.
    await Plan.create({
      name: 'starter',
      displayName: 'Starter',
      price: 0,
      limits: { maxUsers: 1 },
      isActive: true,
    });

    const result = await checkUserLimit(business._id);
    expect(result.limit).toBe(1);
  });
});
