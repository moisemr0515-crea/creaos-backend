const mongoose = require('mongoose');

const PLAN_NAMES = ['starter', 'closer', 'dominator'];

const planSchema = new mongoose.Schema(
  {
    name:        { type: String, enum: PLAN_NAMES, required: true },
    displayName: { type: String, required: true },
    price:       { type: Number, required: true, default: 0 },     // USD/mes
    price_ars:   { type: Number, default: 0 },                     // ARS/mes para MP
    currency:    { type: String, default: 'USD' },
    interval:    { type: String, enum: ['month', 'year'], default: 'month' },
    features:    [String],
    limits: {
      leadsPerMonth:      { type: Number, default: 5 },
      aiEnabled:          { type: Boolean, default: false },
      automationsEnabled: { type: Boolean, default: false },
      // Máximo de automatizaciones ACTIVAS simultáneas (no de automatizaciones
      // creadas/guardadas) permitidas por el plan. Se valida en
      // automation.service#verificarLimiteAutomatizaciones antes de dejar
      // pasar cualquier cambio que deje una automatización en isActive:true.
      // Deliberadamente SIN `default` — si tuviera un default, Mongoose lo
      // rellenaría al leer un Plan preexistente que nunca corrió el seed
      // nuevo, y quedaría indistinguible de un Starter legítimo en 0. El
      // fallback a 0 (fail-closed) vive en automation.service#resolverLimitePlan,
      // que sí puede loguear la diferencia porque ve el `undefined` real.
      maxActiveAutomations: { type: Number },
      whatsappEnabled:    { type: Boolean, default: false },
      multiUser:          { type: Boolean, default: false },
      maxUsers:           { type: Number, default: 1 },
      advancedReports:    { type: Boolean, default: false },
    },
    stripeProductId: String,
    stripePriceId:   String,
    mpPlanId:        String,
    isActive:        { type: Boolean, default: true },
  },
  { timestamps: true }
);

planSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Plan', planSchema);
module.exports.PLAN_NAMES = PLAN_NAMES;
