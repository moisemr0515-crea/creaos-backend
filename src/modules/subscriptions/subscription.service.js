const Stripe       = require('stripe');
const { MercadoPagoConfig, PreApproval } = require('mercadopago');
const Subscription = require('./subscription.model');
const Plan         = require('./plan.model');
const Business     = require('../businesses/business.model');
const User         = require('../users/user.model');
const { AppError } = require('../../middleware/error.middleware');
const {
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  MP_ACCESS_TOKEN, APP_URL, FRONTEND_URL,
} = require('../../config/env');

// ─── Lazy-init clients ────────────────────────────────────────────────────────

let stripe;
const getStripe = () => {
  if (!stripe) {
    if (!STRIPE_SECRET_KEY) throw new AppError('Stripe no configurado', 503);
    stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-06-24.dahlia' });
  }
  return stripe;
};

let mpClient;
const getMP = () => {
  if (!mpClient) {
    if (!MP_ACCESS_TOKEN) throw new AppError('Mercado Pago no configurado', 503);
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
  }
  return mpClient;
};

// ─── 1. getPlans ─────────────────────────────────────────────────────────────

const getPlans = async () => Plan.find({ isActive: true }).sort({ price: 1 });

// ─── 2. getCurrentSubscription ───────────────────────────────────────────────

const getCurrentSubscription = async (businessId) => {
  let sub = await Subscription.findOne({ business: businessId }).populate('plan');

  if (!sub) {
    // Auto-create with free starter plan
    const starterPlan = await Plan.findOne({ name: 'starter', isActive: true });
    if (!starterPlan) throw new AppError('Plan starter no encontrado. Ejecuta npm run seed:plans', 500);

    sub = await Subscription.create({
      business:   businessId,
      plan:       starterPlan._id,
      planName:   'starter',
      status:     'active',
      provider:   'free',
      leadsResetAt: new Date(),
    });
    sub = await Subscription.findById(sub._id).populate('plan');
  }

  // Reset monthly lead counter if needed
  const now       = new Date();
  const resetAt   = new Date(sub.leadsResetAt || 0);
  const nextMonth = new Date(resetAt.getFullYear(), resetAt.getMonth() + 1, 1);
  if (now >= nextMonth) {
    sub.leadsUsedThisMonth = 0;
    sub.leadsResetAt       = now;
    await sub.save();
  }

  return sub;
};

// ─── 3. createStripeCustomer ─────────────────────────────────────────────────

const createStripeCustomer = async (business) => {
  const s   = getStripe();
  const owner = await User.findOne({ business: business._id, isActive: true }).select('email name');
  const customer = await s.customers.create({
    email:    owner?.email,
    name:     business.name,
    metadata: { businessId: business._id.toString() },
  });
  return customer.id;
};

// ─── 4. createStripeSubscription ─────────────────────────────────────────────

const createStripeSubscription = async (businessId, planName, paymentMethodId) => {
  const s    = getStripe();
  const plan = await Plan.findOne({ name: planName, isActive: true });
  if (!plan) throw new AppError('Plan no encontrado', 404);
  if (planName === 'starter') throw new AppError('El plan starter es gratuito', 400);
  if (!plan.stripePriceId) throw new AppError('Plan sin precio de Stripe configurado. Ejecuta npm run seed:plans', 400);

  let sub = await getCurrentSubscription(businessId);
  const business = await Business.findById(businessId);

  // Get or create Stripe customer
  let customerId = sub.stripeCustomerId;
  if (!customerId) {
    customerId = await createStripeCustomer(business);
    await Subscription.findByIdAndUpdate(sub._id, { stripeCustomerId: customerId });
  }

  // Attach payment method to customer
  await s.paymentMethods.attach(paymentMethodId, { customer: customerId });
  await s.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  // Create subscription with 14-day trial for paid plans
  const stripeSubscription = await s.subscriptions.create({
    customer:         customerId,
    items:            [{ price: plan.stripePriceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: {
      payment_method_types:            ['card'],
      save_default_payment_method:     'on_subscription',
    },
    expand:              ['latest_invoice.payment_intent'],
    trial_period_days:   14,
    metadata:            { businessId: businessId.toString(), planName },
  });

  const clientSecret = stripeSubscription.latest_invoice?.payment_intent?.client_secret;

  // Persist in MongoDB
  const now = new Date();
  await Subscription.findByIdAndUpdate(sub._id, {
    plan:                plan._id,
    planName,
    status:              'trialing',
    provider:            'stripe',
    stripeCustomerId:    customerId,
    stripeSubscriptionId: stripeSubscription.id,
    currentPeriodStart:  new Date(stripeSubscription.current_period_start * 1000),
    currentPeriodEnd:    new Date(stripeSubscription.current_period_end * 1000),
    trialEnd:            new Date(stripeSubscription.trial_end * 1000),
  });

  return { subscription: stripeSubscription, clientSecret };
};

// ─── 5. createMercadoPagoSubscription ────────────────────────────────────────

const createMercadoPagoSubscription = async (businessId, planName, payerEmail) => {
  const client = getMP();
  const plan = await Plan.findOne({ name: planName, isActive: true });
  if (!plan) throw new AppError('Plan no encontrado', 404);
  if (planName === 'starter') throw new AppError('El plan starter es gratuito', 400);

  const amount        = plan.price_ars || plan.price * 1000; // fallback: convert USD to ARS x1000
  const callbackUrl   = `${APP_URL}/api/v1/subscriptions/mp/callback`;

  const preApproval   = new PreApproval(client);
  const result        = await preApproval.create({
    body: {
      reason:         `CREA OS ${plan.displayName} - Mensual`,
      payer_email:    payerEmail,
      auto_recurring: {
        frequency:          1,
        frequency_type:     'months',
        transaction_amount: amount,
        currency_id:        'ARS',
      },
      back_url:        callbackUrl,
      status:          'pending',
      metadata: {
        businessId: businessId.toString(),
        planId:     plan._id.toString(),
        planName,
      },
    },
  });

  // Persist pending subscription
  const sub = await getCurrentSubscription(businessId);
  await Subscription.findByIdAndUpdate(sub._id, {
    plan:             plan._id,
    planName,
    status:           'incomplete',
    provider:         'mercadopago',
    mpSubscriptionId: result.id,
  });

  return { initPoint: result.init_point, subscriptionId: result.id };
};

// ─── 6. handleStripeWebhook ──────────────────────────────────────────────────

const handleStripeWebhook = async (rawBody, signature) => {
  const s = getStripe();
  let event;

  if (!STRIPE_WEBHOOK_SECRET || STRIPE_WEBHOOK_SECRET === 'whsec_placeholder') {
    event = JSON.parse(rawBody.toString());
  } else {
    event = s.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  }

  const data = event.data?.object;

  switch (event.type) {
    case 'customer.subscription.updated': {
      const sub = await Subscription.findOne({ stripeSubscriptionId: data.id });
      if (!sub) break;
      await Subscription.findByIdAndUpdate(sub._id, {
        status:             data.status,
        currentPeriodStart: new Date(data.current_period_start * 1000),
        currentPeriodEnd:   new Date(data.current_period_end * 1000),
        cancelAtPeriodEnd:  data.cancel_at_period_end,
        trialEnd:           data.trial_end ? new Date(data.trial_end * 1000) : undefined,
      });
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = await Subscription.findOne({ stripeSubscriptionId: data.id });
      if (!sub) break;
      const starter = await Plan.findOne({ name: 'starter' });
      await Subscription.findByIdAndUpdate(sub._id, {
        status:    'canceled',
        canceledAt: new Date(),
        plan:      starter?._id,
        planName:  'starter',
        provider:  'free',
        cancelAtPeriodEnd: false,
      });
      break;
    }

    case 'invoice.payment_succeeded': {
      const stripeSubId = data.subscription;
      if (!stripeSubId) break;
      const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSubId });
      if (!sub) break;
      await Subscription.findByIdAndUpdate(sub._id, {
        status: 'active',
        $push: {
          paymentHistory: {
            amount:            data.amount_paid / 100,
            currency:          data.currency.toUpperCase(),
            status:            'succeeded',
            provider:          'stripe',
            providerPaymentId: data.payment_intent,
            description:       `Pago ${data.billing_reason}`,
            paidAt:            new Date(data.status_transitions?.paid_at * 1000 || Date.now()),
          },
        },
      });
      break;
    }

    case 'invoice.payment_failed': {
      const stripeSubId = data.subscription;
      if (!stripeSubId) break;
      await Subscription.findOneAndUpdate(
        { stripeSubscriptionId: stripeSubId },
        {
          status: 'past_due',
          $push: {
            paymentHistory: {
              amount:   data.amount_due / 100,
              currency: data.currency.toUpperCase(),
              status:   'failed',
              provider: 'stripe',
              providerPaymentId: data.payment_intent,
              description: 'Pago fallido',
              paidAt:   new Date(),
            },
          },
        }
      );
      break;
    }
  }

  return { received: true, type: event.type };
};

// ─── 7. handleMercadoPagoWebhook ─────────────────────────────────────────────

const handleMercadoPagoWebhook = async (data) => {
  const { type, data: notification } = data;
  if (type !== 'preapproval' || !notification?.id) return;

  try {
    const client = getMP();
    const pa     = new PreApproval(client);
    const mpSub  = await pa.get({ id: notification.id });

    const businessId = mpSub.metadata?.businessId;
    const planId     = mpSub.metadata?.planId;
    if (!businessId) return;

    if (mpSub.status === 'authorized') {
      await Subscription.findOneAndUpdate(
        { business: businessId },
        {
          plan:             planId,
          planName:         mpSub.metadata?.planName || 'closer',
          status:           'active',
          provider:         'mercadopago',
          mpSubscriptionId: mpSub.id,
          mpPayerId:        String(mpSub.payer_id || ''),
          currentPeriodStart: new Date(),
          currentPeriodEnd:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        { upsert: true }
      );
    } else if (['cancelled', 'paused'].includes(mpSub.status)) {
      const starter = await Plan.findOne({ name: 'starter' });
      await Subscription.findOneAndUpdate(
        { mpSubscriptionId: mpSub.id },
        { status: 'canceled', canceledAt: new Date(), plan: starter?._id, planName: 'starter', provider: 'free' }
      );
    }
  } catch (err) {
    console.error('[MP webhook]', err.message);
  }
};

// ─── 8. cancelSubscription ───────────────────────────────────────────────────

const cancelSubscription = async (businessId, atPeriodEnd = true) => {
  const sub = await Subscription.findOne({ business: businessId });
  if (!sub) throw new AppError('No hay suscripción activa', 404);

  if (sub.provider === 'stripe' && sub.stripeSubscriptionId) {
    const s = getStripe();
    if (atPeriodEnd) {
      await s.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
      await Subscription.findByIdAndUpdate(sub._id, { cancelAtPeriodEnd: true });
      return { message: 'Cancelación programada al fin del período de facturación' };
    }
    await s.subscriptions.cancel(sub.stripeSubscriptionId);
  } else if (sub.provider === 'mercadopago' && sub.mpSubscriptionId) {
    const client = getMP();
    const pa     = new PreApproval(client);
    await pa.update({ id: sub.mpSubscriptionId, body: { status: 'cancelled' } });
  }

  const starter = await Plan.findOne({ name: 'starter' });
  await Subscription.findByIdAndUpdate(sub._id, {
    status:    'canceled',
    canceledAt: new Date(),
    plan:      starter?._id,
    planName:  'starter',
    provider:  'free',
  });
  return { message: 'Suscripción cancelada exitosamente' };
};

// ─── 9. checkLeadLimit ───────────────────────────────────────────────────────

const checkLeadLimit = async (businessId) => {
  const sub = await getCurrentSubscription(businessId);
  const limit = sub.plan?.limits?.leadsPerMonth ?? 5;

  if (limit === -1) return { allowed: true, current: sub.leadsUsedThisMonth, limit: -1 };

  const allowed = sub.leadsUsedThisMonth < limit;
  return { allowed, current: sub.leadsUsedThisMonth, limit };
};

// ─── 10. incrementLeadCount ───────────────────────────────────────────────────

const incrementLeadCount = async (businessId) => {
  const sub = await Subscription.findOne({ business: businessId });
  if (!sub) return;

  const now              = new Date();
  const resetAt          = sub.leadsResetAt ? new Date(sub.leadsResetAt) : new Date(0);
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (resetAt < startOfThisMonth) {
    // Nuevo mes — reinicia el contador y cuenta este lead como el primero
    await Subscription.findByIdAndUpdate(sub._id, {
      leadsUsedThisMonth: 1,
      leadsResetAt:       now,
    });
  } else {
    await Subscription.findByIdAndUpdate(sub._id, {
      $inc: { leadsUsedThisMonth: 1 },
    });
  }
};

module.exports = {
  getPlans,
  getCurrentSubscription,
  createStripeCustomer,
  createStripeSubscription,
  createMercadoPagoSubscription,
  handleStripeWebhook,
  handleMercadoPagoWebhook,
  cancelSubscription,
  checkLeadLimit,
  incrementLeadCount,
};
