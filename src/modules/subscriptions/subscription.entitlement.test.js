const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const { getEntitlement, assertCapability } = require('./subscription.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_entitlement_p1';

describe('entitlement P1-1', () => {
  let business;
  const limits = {
    starter: { leadsPerMonth: 20, maxUsers: 1, multiUser: false, maxActiveAutomations: 0, aiEnabled: true, whatsappEnabled: true },
    closer: { leadsPerMonth: 300, maxUsers: 1, multiUser: false, maxActiveAutomations: 100, aiEnabled: true, whatsappEnabled: true, automationsEnabled: true },
    dominator: { leadsPerMonth: 1000, maxUsers: 1, multiUser: false, maxActiveAutomations: 400, aiEnabled: true, whatsappEnabled: true, automationsEnabled: true, advancedReports: true },
  };

  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    business = await Business.create({ name: 'Entitlement test' });
    await Plan.insertMany(Object.entries(limits).map(([name, planLimits]) => ({ name, displayName: name, price: 0, limits: planLimits })));
  });

  async function subscribe(planName, status = 'active', pending = {}) {
    const plan = await Plan.findOne({ name: planName });
    return Subscription.create({ business: business._id, plan: plan._id, planName, status, provider: planName === 'starter' ? 'free' : 'stripe', ...pending });
  }

  test('Starter obtiene IA asistida y WhatsApp, pero no automatizaciones', async () => {
    await subscribe('starter');
    const entitlement = await getEntitlement(business._id);
    expect(entitlement.limits).toMatchObject({ aiEnabled: true, whatsappEnabled: true, automationsEnabled: false, maxUsers: 1, multiUser: false });
    await expect(assertCapability(business._id, 'aiEnabled')).resolves.toBeTruthy();
    await expect(assertCapability(business._id, 'automationsEnabled')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('Closer obtiene sus capacidades y límites canónicos', async () => {
    await subscribe('closer');
    const entitlement = await getEntitlement(business._id);
    expect(entitlement.planName).toBe('closer');
    expect(entitlement.limits).toMatchObject({ leadsPerMonth: 300, maxUsers: 1, multiUser: false, maxActiveAutomations: 100, aiEnabled: true, whatsappEnabled: true });
  });

  test('Dominator obtiene capacidades y reportes avanzados', async () => {
    await subscribe('dominator');
    const entitlement = await getEntitlement(business._id);
    expect(entitlement.limits).toMatchObject({ leadsPerMonth: 1000, maxUsers: 1, multiUser: false, maxActiveAutomations: 400, advancedReports: true });
  });

  test.each(['incomplete', 'past_due', 'canceled'])('estado %s falla cerrado a Starter', async (status) => {
    const pendingPlan = await Plan.findOne({ name: 'dominator' });
    await subscribe('starter', status, { pendingPlan: pendingPlan._id, pendingPlanName: 'dominator', pendingProvider: 'stripe', pendingStatus: 'pending' });
    const entitlement = await getEntitlement(business._id);
    expect(entitlement.planName).toBe('starter');
    expect(entitlement.limits).toMatchObject({
      maxUsers: 1,
      multiUser: false,
      automationsEnabled: false,
      maxActiveAutomations: 0,
    });
  });
});
