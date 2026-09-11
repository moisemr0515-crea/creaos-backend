const mongoose = require('mongoose');

const TRIGGER_TYPES = [
  'lead_created',
  'lead_stage_changed',
  'lead_assigned',
  'webhook_received',
  'conversation_started',
  'lead_temperature_changed',
  'manual',
  // Triggers "de tiempo" (Caso 7 del backlog) — a diferencia de los de
  // arriba, nadie los dispara con un evento puntual: un job repetible los
  // reevalúa periódicamente contra todos los leads activos de cada negocio
  // (ver src/modules/automations/timeTriggers.registry.js y
  // src/modules/automations/workers/automationSweep.worker.js). Bloquean
  // hoy a las automatizaciones semilla "Seguimientos automáticos"/"Cierre
  // automático" (Caso 5, ver docs/implementation/known-issues.md) — este
  // PR agrega solo la capacidad del motor, no la lógica de negocio de qué
  // umbral usa cada una (eso lo define Caso 5 al cablearse de verdad).
  'lead_stale',
  'stage_stalled',
];

const ACTION_TYPES = [
  'create_lead',
  'update_lead',
  'assign_lead',
  'change_stage',
  'add_tag',
  'add_note',
  'start_ai_conversation',
  'send_notification',
  'wait',
];

const CONDITION_OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than'];

const conditionSchema = new mongoose.Schema(
  {
    field:    { type: String, required: true },
    operator: { type: String, enum: CONDITION_OPERATORS, required: true },
    value:    { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const actionSchema = new mongoose.Schema(
  {
    order:  { type: Number, required: true, min: 1 },
    type:   { type: String, enum: ACTION_TYPES, required: true },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    delay:  { type: Number, default: 0, min: 0, max: 86400 }, // segundos, máx 24h
  },
  { _id: false }
);

// Discrimina automatizaciones "de producto" (las 2 semillas fijas que
// controlan los toggles "Seguimientos automáticos" / "Cierre automático" en
// business.tsx) de las automatizaciones custom que el usuario arma libremente
// vía POST /automations. 'custom' es el default y es lo único que un usuario
// puede crear por API — 'followup'/'auto_close' los asigna únicamente el
// seed lazy interno (ver automation.service#asegurarAutomatizacionesSemilla),
// no están expuestos en createAutomationSchema/updateAutomationSchema.
const AUTOMATION_TYPES = ['custom', 'followup', 'auto_close'];

const automationSchema = new mongoose.Schema(
  {
    business:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name:        { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 500 },
    type:        { type: String, enum: AUTOMATION_TYPES, default: 'custom' },
    isActive:    { type: Boolean, default: true },
    isDeleted:   { type: Boolean, default: false },
    trigger: {
      type:       { type: String, enum: TRIGGER_TYPES, required: true },
      conditions: { type: [conditionSchema], default: [] },
    },
    actions: {
      type:     [actionSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'La automatización debe tener al menos una acción',
      },
    },
    stats: {
      totalExecutions: { type: Number, default: 0 },
      successCount:    { type: Number, default: 0 },
      errorCount:      { type: Number, default: 0 },
      lastExecutedAt:  { type: Date },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

automationSchema.index({ business: 1, isActive: 1, isDeleted: 1 });
automationSchema.index({ business: 1, 'trigger.type': 1, isActive: 1, isDeleted: 1 });
// Sin `business` como prefijo, a propósito — el índice de arriba sirve para
// "qué automatizaciones tiene ESTE negocio" (el caso de uso de siempre,
// triggerAutomations() ya conoce el business del lead que disparó el
// evento). El job de barrido de triggers de tiempo (Caso 7) hace la
// pregunta inversa: "en TODOS los negocios, qué automatizaciones activas
// tienen un trigger de tiempo" — sin este índice, esa query escanearía la
// colección completa en cada ciclo del barrido.
automationSchema.index({ 'trigger.type': 1, isActive: 1, isDeleted: 1 });
// Como mucho 1 'followup' y 1 'auto_close' por negocio — protege el upsert
// del seed lazy contra condiciones de carrera (dos requests concurrentes
// intentando sembrar al mismo tiempo). 'custom' queda fuera del filtro, así
// que los usuarios pueden seguir creando tantas automatizaciones custom
// como quieran.
automationSchema.index(
  { business: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['followup', 'auto_close'] } } }
);

module.exports = mongoose.model('Automation', automationSchema);
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
module.exports.ACTION_TYPES  = ACTION_TYPES;
module.exports.AUTOMATION_TYPES = AUTOMATION_TYPES;
