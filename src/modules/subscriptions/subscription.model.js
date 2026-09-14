const mongoose = require('mongoose');

const paymentHistorySchema = new mongoose.Schema(
  {
    amount:            { type: Number, required: true },
    currency:          { type: String, required: true },
    status:            { type: String, enum: ['succeeded', 'failed', 'pending'], required: true },
    provider:          { type: String, required: true },
    providerPaymentId: String,
    description:       String,
    paidAt:            { type: Date, default: Date.now },
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    plan:     { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    planName: { type: String, enum: ['starter', 'closer', 'dominator'], default: 'starter' },
    status:   {
      type:    String,
      enum:    ['active', 'trialing', 'past_due', 'canceled', 'incomplete'],
      default: 'active',
    },
    provider: { type: String, enum: ['stripe', 'mercadopago', 'free'], default: 'free' },

    // Stripe
    stripeCustomerId:     String,
    stripeSubscriptionId: String,

    // Mercado Pago
    mpSubscriptionId: String,
    mpPayerId:        String,

    // Cambio de plan solicitado pero todavía no autorizado por el proveedor.
    // Nunca se usa para conceder capacidades; el entitlement efectivo solo
    // lee plan/planName cuando la suscripción está active/trialing.
    pendingPlan:     { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    pendingPlanName: { type: String, enum: ['starter', 'closer', 'dominator'] },
    pendingProvider: { type: String, enum: ['stripe', 'mercadopago'] },
    pendingStatus:   { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'] },

    // Periodo actual
    currentPeriodStart: Date,
    currentPeriodEnd:   Date,
    trialEnd:           Date,
    cancelAtPeriodEnd:  { type: Boolean, default: false },
    canceledAt:         Date,

    // Uso mensual
    leadsUsedThisMonth: { type: Number, default: 0 },
    leadsResetAt:       { type: Date, default: Date.now },

    paymentHistory: { type: [paymentHistorySchema], default: [] },
    processedWebhookEvents: { type: [String], default: [] },
  },
  { timestamps: true }
);

subscriptionSchema.index({ business: 1 }, { unique: true });
subscriptionSchema.index({ status: 1 });
subscriptionSchema.index({ stripeSubscriptionId: 1 });
subscriptionSchema.index({ mpSubscriptionId: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
