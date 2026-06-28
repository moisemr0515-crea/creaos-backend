const mongoose = require('mongoose');

const TRIGGER_TYPES = [
  'lead_created',
  'lead_stage_changed',
  'lead_assigned',
  'webhook_received',
  'conversation_started',
  'lead_temperature_changed',
  'manual',
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

const automationSchema = new mongoose.Schema(
  {
    business:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name:        { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, maxlength: 500 },
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

module.exports = mongoose.model('Automation', automationSchema);
module.exports.TRIGGER_TYPES = TRIGGER_TYPES;
module.exports.ACTION_TYPES  = ACTION_TYPES;
