const crypto        = require('crypto');
const Stripe       = require('stripe');
const { MercadoPagoConfig, PreApproval } = require('mercadopago');
const Subscription = require('./subscription.model');
const Plan         = require('./plan.model');
const Business     = require('../businesses/business.model');
const User         = require('../users/user.model');
const Pipeline     = require('../pipeline/pipeline.model');
const Lead         = require('../leads/lead.model');
const { AppError } = require('../../middleware/error.middleware');
const {
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, APP_URL, FRONTEND_URL, NODE_ENV,
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

const ENTITLED_STATUSES = new Set(['active', 'trialing']);
const CAPABILITY_LABELS = {
  aiEnabled: 'IA',
  whatsappEnabled: 'WhatsApp',
  automationsEnabled: 'automatizaciones',
  advancedReports: 'reportes avanzados',
};

const normalizeLimits = (limits = {}) => ({
  leadsPerMonth: Number.isFinite(limits.leadsPerMonth) ? limits.leadsPerMonth : 20,
  aiEnabled: limits.aiEnabled === true,
  automationsEnabled: limits.automationsEnabled === true,
  maxActiveAutomations: Number.isFinite(limits.maxActiveAutomations) ? limits.maxActiveAutomations : 0,
  whatsappEnabled: limits.whatsappEnabled === true,
  multiUser: limits.multiUser === true,
  maxUsers: Number.isFinite(limits.maxUsers) ? limits.maxUsers : 1,
  advancedReports: limits.advancedReports === true,
});

const getEntitlement = async (businessId, existingSubscription = null) => {
  const sub = existingSubscription || await getCurrentSubscription(businessId);
  let effectivePlan = ENTITLED_STATUSES.has(sub.status) ? sub.plan : null;
  if (!effectivePlan) {
    effectivePlan = await Plan.findOne({ name: 'starter', isActive: true });
    if (!effectivePlan) throw new AppError('Plan starter no encontrado. Ejecuta npm run seed:plans', 500);
  }
  return {
    planName: effectivePlan.name || 'starter',
    subscriptionStatus: sub.status,
    provider: sub.provider,
    limits: normalizeLimits(effectivePlan.limits),
    pending: sub.pendingStatus ? {
      planName: sub.pendingPlanName || null,
      provider: sub.pendingProvider || null,
      status: sub.pendingStatus,
    } : null,
  };
};

const assertCapability = async (businessId, capability) => {
  if (!Object.prototype.hasOwnProperty.call(CAPABILITY_LABELS, capability)) {
    throw new AppError('Capacidad de plan desconocida', 500);
  }
  const entitlement = await getEntitlement(businessId);
  if (entitlement.limits[capability] !== true) {
    throw new AppError(`Tu plan actual no incluye ${CAPABILITY_LABELS[capability]}`, 403);
  }
  return entitlement;
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

  const providerStatus = stripeSubscription.status;
  const authorized = ENTITLED_STATUSES.has(providerStatus);
  const update = {
    stripeCustomerId:    customerId,
    stripeSubscriptionId: stripeSubscription.id,
    currentPeriodStart:  new Date(stripeSubscription.current_period_start * 1000),
    currentPeriodEnd:    new Date(stripeSubscription.current_period_end * 1000),
    trialEnd:            stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : undefined,
    pendingPlan:         plan._id,
    pendingPlanName:     planName,
    pendingProvider:     'stripe',
    pendingStatus:       authorized ? 'approved' : 'pending',
  };
  if (authorized) Object.assign(update, { plan: plan._id, planName, status: providerStatus, provider: 'stripe' });
  await Subscription.findByIdAndUpdate(sub._id, update);

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

  // Registra la intención; no cambia el plan efectivo antes del webhook.
  const sub = await getCurrentSubscription(businessId);
  await Subscription.findByIdAndUpdate(sub._id, {
    mpSubscriptionId: result.id,
    pendingPlan:      plan._id,
    pendingPlanName:  planName,
    pendingProvider:  'mercadopago',
    pendingStatus:    'pending',
  });

  return { initPoint: result.init_point, subscriptionId: result.id };
};

// ─── 6. handleStripeWebhook ──────────────────────────────────────────────────

const handleStripeWebhook = async (rawBody, signature) => {
  if (NODE_ENV === 'production' && !STRIPE_WEBHOOK_SECRET) {
    throw new AppError('Stripe webhook no configurado de forma segura', 503);
  }
  const s = getStripe();
  let event;

  if (NODE_ENV !== 'production' && (!STRIPE_WEBHOOK_SECRET || STRIPE_WEBHOOK_SECRET === 'whsec_placeholder')) {
    event = JSON.parse(rawBody.toString());
  } else {
    event = s.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  }

  const data = event.data?.object;

  if (event.id && await Subscription.exists({ processedWebhookEvents: event.id })) {
    return { received: true, type: event.type, duplicate: true };
  }

  switch (event.type) {
    case 'customer.subscription.updated': {
      const sub = await Subscription.findOne({ stripeSubscriptionId: data.id });
      if (!sub) break;
      const update = {
        status:             data.status,
        currentPeriodStart: new Date(data.current_period_start * 1000),
        currentPeriodEnd:   new Date(data.current_period_end * 1000),
        cancelAtPeriodEnd:  data.cancel_at_period_end,
        trialEnd:           data.trial_end ? new Date(data.trial_end * 1000) : undefined,
      };
      if (ENTITLED_STATUSES.has(data.status) && sub.pendingPlan && sub.pendingPlanName) {
        Object.assign(update, {
          plan: sub.pendingPlan,
          planName: sub.pendingPlanName,
          provider: 'stripe',
          pendingStatus: 'approved',
        });
      }
      if (event.id) update.$addToSet = { processedWebhookEvents: event.id };
      await Subscription.findByIdAndUpdate(sub._id, update);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = await Subscription.findOne({ stripeSubscriptionId: data.id });
      if (!sub) break;
      const starter = await Plan.findOne({ name: 'starter' });
      const update = {
        status:    'canceled',
        canceledAt: new Date(),
        plan:      starter?._id,
        planName:  'starter',
        provider:  'free',
        cancelAtPeriodEnd: false,
      };
      if (event.id) update.$addToSet = { processedWebhookEvents: event.id };
      await Subscription.findByIdAndUpdate(sub._id, update);
      break;
    }

    case 'invoice.payment_succeeded': {
      const stripeSubId = data.subscription;
      if (!stripeSubId) break;
      const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSubId });
      if (!sub) break;
      await Subscription.findOneAndUpdate({
        _id: sub._id,
        ...(event.id ? { processedWebhookEvents: { $ne: event.id } } : {}),
      }, {
        status: 'active',
        ...(sub.pendingProvider === 'stripe' && sub.pendingPlan && sub.pendingPlanName ? {
          plan: sub.pendingPlan,
          planName: sub.pendingPlanName,
          provider: 'stripe',
          pendingStatus: 'approved',
        } : {}),
        ...(event.id ? { $addToSet: { processedWebhookEvents: event.id } } : {}),
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
        {
          stripeSubscriptionId: stripeSubId,
          ...(event.id ? { processedWebhookEvents: { $ne: event.id } } : {}),
        },
        {
          status: 'past_due',
          ...(event.id ? { $addToSet: { processedWebhookEvents: event.id } } : {}),
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

// ─── 7. verifyMercadoPagoSignature ───────────────────────────────────────────
// Doc: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks#editor_5

const verifyMercadoPagoSignature = (dataId, requestId, signatureHeader) => {
  if (NODE_ENV !== 'production' && !MP_WEBHOOK_SECRET) return true;
  if (!MP_WEBHOOK_SECRET || !signatureHeader || !dataId) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId || ''};ts:${ts};`;
  const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch {
    return false;
  }
};

// ─── 8. handleMercadoPagoWebhook ─────────────────────────────────────────────

const handleMercadoPagoWebhook = async (data) => {
  const { type, data: notification } = data;
  if (type !== 'preapproval' || !notification?.id) return;

  const client = getMP();
  const pa     = new PreApproval(client);
  const mpSub  = await pa.get({ id: notification.id });
  const sub = await Subscription.findOne({ mpSubscriptionId: String(mpSub.id) });
  if (!sub) return { received: true, ignored: true };

  const metadata = mpSub.metadata || {};
  const businessId = metadata.businessId || metadata.business_id;
  const planId = metadata.planId || metadata.plan_id;
  const planName = metadata.planName || metadata.plan_name;
  const metadataMatches = String(sub.business) === String(businessId)
    && String(sub.pendingPlan) === String(planId)
    && sub.pendingPlanName === planName
    && sub.pendingProvider === 'mercadopago';
  if (!metadataMatches) throw new AppError('Metadata de suscripción Mercado Pago inválida', 400);

  const plan = await Plan.findOne({ _id: planId, name: planName, isActive: true });
  if (!plan) throw new AppError('Plan de Mercado Pago inválido', 400);

  if (mpSub.status === 'authorized') {
    const activated = await Subscription.findOneAndUpdate(
      { _id: sub._id, pendingStatus: { $ne: 'approved' } },
      {
        plan: plan._id,
        planName: plan.name,
        status: 'active',
        provider: 'mercadopago',
        mpPayerId: String(mpSub.payer_id || ''),
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        pendingStatus: 'approved',
      },
      { new: true }
    );
    return { received: true, activated: Boolean(activated), duplicate: !activated };
  }

  if (['cancelled', 'paused', 'rejected'].includes(mpSub.status)) {
    if (sub.pendingStatus === 'approved') {
      const starter = await Plan.findOne({ name: 'starter' });
      await Subscription.findByIdAndUpdate(sub._id, {
        status: 'canceled', canceledAt: new Date(), plan: starter?._id,
        planName: 'starter', provider: 'free', pendingStatus: 'cancelled',
      });
    } else {
      await Subscription.findByIdAndUpdate(sub._id, {
        pendingStatus: mpSub.status === 'rejected' ? 'rejected' : 'cancelled',
      });
    }
  }
  return { received: true };
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

/**
 * Reescrita (auditoría de pricing del 23/ago/2026) — ya NO mide "leads
 * creados este mes" contra `leadsUsedThisMonth` (ese contador nunca se
 * incrementaba en ningún lado, ver incrementLeadCount() abajo — el límite
 * nunca se aplicaba en la práctica). Mide "leads ACTIVOS" en vivo, alineado
 * al copy real de pricing ("gestioná hasta N oportunidades de venta
 * activas"): cualquier lead no borrado cuyo stage actual no sea de cierre
 * (won/lost) en el pipeline al que pertenece.
 *
 * Conteo en vivo en vez de un contador denormalizado a propósito: un
 * contador exige acordarse de sumar en cada creación Y restar en cada
 * borrado/cierre/reapertura, en los ~6 lugares distintos del repo que hoy
 * crean un Lead — exactamente la clase de bug que esta función reemplaza
 * (incrementLeadCount() nunca se llamó desde ninguno). Un conteo en vivo no
 * puede desincronizarse porque no hay nada que sincronizar. Costo real:
 * un countDocuments() indexado ({business,isDeleted} ya existe, ver
 * lead.model.js) sobre, como mucho, unos cientos de leads por negocio — de
 * un dígito de milisegundos, y esto corre una vez por intento de creación
 * (escritura humana, no un endpoint de lectura de alto tráfico).
 *
 * Límite conocido: si un negocio tiene más de un Pipeline activo y dos de
 * ellos usan la misma `stage.key` con isWon/isLost distinto, el stage se
 * cuenta como "de cierre" si CUALQUIERA de los pipelines del negocio lo
 * marca así (unión, no por-pipeline-del-lead). Caso de borde improbable en
 * la práctica (casi todo negocio tiene 1 solo pipeline) — si aparece uno
 * real con pipelines múltiples y keys ambiguas, ahí se justifica resolver
 * el pipeline exacto de cada lead vía agregación; no antes.
 */
const checkLeadLimit = async (businessId) => {
  const entitlement = await getEntitlement(businessId);
  const limit = entitlement.limits.leadsPerMonth;

  if (limit === -1) {
    const current = await contarLeadsActivos(businessId);
    return { allowed: true, current, limit: -1 };
  }

  const current = await contarLeadsActivos(businessId);
  return { allowed: current < limit, current, limit };
};

/**
 * Cuenta los leads "activos" (no borrados, no en un stage won/lost) de un
 * negocio, considerando los stages de cierre de TODOS sus pipelines activos
 * — ver el límite conocido documentado arriba en checkLeadLimit().
 */
const contarLeadsActivos = async (businessId) => {
  const pipelines = await Pipeline.find({ business: businessId, isActive: true }).select('stages').lean();
  const stagesDeCierre = new Set(
    pipelines.flatMap((p) => (p.stages || []).filter((s) => s.isWon || s.isLost).map((s) => s.key))
  );

  return Lead.countDocuments({
    business: businessId,
    isDeleted: false,
    pipelineStage: { $nin: [...stagesDeCierre] },
  });
};

// ─── 9b. checkUserLimit ──────────────────────────────────────────────────────

/**
 * Enforcement real de Plan.limits.maxUsers (auditoría de pricing del
 * 23/ago/2026, Track 1 #3) — hasta acá inviteUser() (admin.controller.js)
 * no leía el plan del negocio en absoluto. Mismo criterio que
 * checkLeadLimit(): conteo en vivo, no un contador denormalizado — liberar
 * cupo (desactivar o borrar un usuario) ya funciona solo, sin código nuevo,
 * porque no hay nada que sincronizar.
 *
 * Fallback `?? 1` (no `?? 10` como en leads) a propósito: es el valor real
 * de Starter, el plan más restrictivo — si el Plan de un negocio no está
 * bien poblado, fail-closed al mínimo, nunca de más.
 */
const checkUserLimit = async (businessId) => {
  const entitlement = await getEntitlement(businessId);
  const limit = entitlement.limits.maxUsers;
  const current = await User.countDocuments({ business: businessId, isActive: true });
  return { allowed: current < limit, current, limit };
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
  getEntitlement,
  assertCapability,
  createStripeCustomer,
  createStripeSubscription,
  createMercadoPagoSubscription,
  handleStripeWebhook,
  verifyMercadoPagoSignature,
  handleMercadoPagoWebhook,
  cancelSubscription,
  checkLeadLimit,
  contarLeadsActivos,
  checkUserLimit,
  incrementLeadCount, // sin callers hoy (ver checkLeadLimit) — se deja por si sirve para reporting de "leads creados por mes" a futuro
};
