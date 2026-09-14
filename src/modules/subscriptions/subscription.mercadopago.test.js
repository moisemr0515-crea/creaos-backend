const mongoose = require('mongoose');

const mockCreate = jest.fn();
const mockGet = jest.fn();
jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  PreApproval: jest.fn().mockImplementation(() => ({ create: mockCreate, get: mockGet, update: jest.fn() })),
}));
jest.mock('../../config/env', () => ({
  NODE_ENV: 'test', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  MP_ACCESS_TOKEN: 'mp-test', MP_WEBHOOK_SECRET: '',
  APP_URL: 'http://api.test', FRONTEND_URL: 'http://front.test',
}));

const Business = require('../businesses/business.model');
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const service = require('./subscription.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_mp_p1';

describe('Mercado Pago P1-1', () => {
  let business;
  let starter;
  let closer;

  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    await mongoose.connection.dropDatabase();
    business = await Business.create({ name: 'MP test' });
    starter = await Plan.create({ name: 'starter', displayName: 'Starter', price: 0, limits: { leadsPerMonth: 20 } });
    closer = await Plan.create({ name: 'closer', displayName: 'Closer', price: 29, price_ars: 29000, limits: { leadsPerMonth: 300, aiEnabled: true } });
    await Subscription.create({ business: business._id, plan: starter._id, planName: 'starter', status: 'active', provider: 'free' });
    mockCreate.mockResolvedValue({ id: 'preapproval-1', init_point: 'https://checkout.test/1' });
  });

  async function startCheckout() {
    return service.createMercadoPagoSubscription(business._id, 'closer', 'payer@test.local');
  }

  function providerState(status, overrides = {}) {
    return {
      id: 'preapproval-1', status, payer_id: 123,
      metadata: { businessId: String(business._id), planId: String(closer._id), planName: 'closer' },
      ...overrides,
    };
  }

  test('checkout pending conserva Starter y solo registra intención', async () => {
    await startCheckout();
    const sub = await Subscription.findOne({ business: business._id });
    expect(sub.planName).toBe('starter');
    expect(sub.status).toBe('active');
    expect(sub.pendingPlanName).toBe('closer');
    expect(sub.pendingStatus).toBe('pending');
  });

  test('pago rejected no concede el plan', async () => {
    await startCheckout();
    mockGet.mockResolvedValue(providerState('rejected'));
    await service.handleMercadoPagoWebhook({ type: 'preapproval', data: { id: 'preapproval-1' } });
    const sub = await Subscription.findOne({ business: business._id });
    expect(sub.planName).toBe('starter');
    expect(sub.pendingStatus).toBe('rejected');
  });

  test('pago authorized concede Closer una sola vez y duplicado es idempotente', async () => {
    await startCheckout();
    mockGet.mockResolvedValue(providerState('authorized'));
    const first = await service.handleMercadoPagoWebhook({ type: 'preapproval', data: { id: 'preapproval-1' } });
    const second = await service.handleMercadoPagoWebhook({ type: 'preapproval', data: { id: 'preapproval-1' } });
    const sub = await Subscription.findOne({ business: business._id });
    expect(first.activated).toBe(true);
    expect(second).toMatchObject({ activated: false, duplicate: true });
    expect(sub.planName).toBe('closer');
    expect(sub.status).toBe('active');
  });

  test('metadata manipulada es rechazada y no concede plan', async () => {
    await startCheckout();
    mockGet.mockResolvedValue(providerState('authorized', { metadata: { businessId: String(business._id), planId: String(closer._id), planName: 'dominator' } }));
    await expect(service.handleMercadoPagoWebhook({ type: 'preapproval', data: { id: 'preapproval-1' } })).rejects.toMatchObject({ statusCode: 400 });
    expect((await Subscription.findOne({ business: business._id })).planName).toBe('starter');
  });
});
