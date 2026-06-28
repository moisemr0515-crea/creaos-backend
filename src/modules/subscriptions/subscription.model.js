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
  },
  { timestamps: true }
);

subscriptionSchema.index({ business: 1 }, { unique: true });
subscriptionSchema.index({ status: 1 });
subscriptionSchema.index({ stripeSubscriptionId: 1 });
subscriptionSchema.index({ mpSubscriptionId: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
