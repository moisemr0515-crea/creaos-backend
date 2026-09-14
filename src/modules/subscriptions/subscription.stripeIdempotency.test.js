const mongoose = require('mongoose');

let mockStripeEvent;
const mockStripeInstance = { webhooks: { constructEvent: jest.fn(() => mockStripeEvent) } };
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));
jest.mock('../../config/env', () => ({
  NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', APP_URL: 'http://api.test', FRONTEND_URL: 'http://front.test',
}));

const Business = require('../businesses/business.model');
const Plan = require('./plan.model');
const Subscription = require('./subscription.model');
const { handleStripeWebhook } = require('./subscription.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_stripe_idempotency_p1';

describe('Stripe webhook idempotente', () => {
  beforeAll(async () => mongoose.connect(MONGO_URI));
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  test('el mismo invoice.payment_succeeded se registra y activa una sola vez', async () => {
    await mongoose.connection.dropDatabase();
    const business = await Business.create({ name: 'Stripe test' });
    const starter = await Plan.create({ name: 'starter', displayName: 'Starter', price: 0, limits: { leadsPerMonth: 20 } });
    const closer = await Plan.create({ name: 'closer', displayName: 'Closer', price: 29, limits: { leadsPerMonth: 300, aiEnabled: true } });
    await Subscription.create({
      business: business._id, plan: starter._id, planName: 'starter', status: 'active', provider: 'free',
      stripeSubscriptionId: 'sub_1', pendingPlan: closer._id, pendingPlanName: 'closer', pendingProvider: 'stripe', pendingStatus: 'pending',
    });
    mockStripeEvent = {
      id: 'evt_same', type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_1', amount_paid: 2900, currency: 'usd', payment_intent: 'pi_1', billing_reason: 'subscription_cycle', status_transitions: { paid_at: 1700000000 } } },
    };

    await handleStripeWebhook(Buffer.from('{}'), 'signature');
    await handleStripeWebhook(Buffer.from('{}'), 'signature');

    const sub = await Subscription.findOne({ business: business._id });
    expect(sub.planName).toBe('closer');
    expect(sub.status).toBe('active');
    expect(sub.paymentHistory).toHaveLength(1);
    expect(sub.processedWebhookEvents).toEqual(['evt_same']);
  });
});
