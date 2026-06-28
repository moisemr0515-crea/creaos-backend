const mongoose = require('mongoose');

const actionResultSchema = new mongoose.Schema(
  {
    order:      { type: Number },
    type:       { type: String },
    status:     { type: String, enum: ['success', 'failed', 'skipped'] },
    result:     { type: mongoose.Schema.Types.Mixed },
    error:      { type: String },
    executedAt: { type: Date },
  },
  { _id: false }
);

const automationLogSchema = new mongoose.Schema(
  {
    business:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    automation: { type: mongoose.Schema.Types.ObjectId, ref: 'Automation', required: true },
    lead:       { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    trigger: {
      type: { type: String },
      data: { type: mongoose.Schema.Types.Mixed },
    },
    status:          { type: String, enum: ['running', 'completed', 'failed', 'partial'], default: 'running' },
    actionsExecuted: { type: [actionResultSchema], default: [] },
    startedAt:       { type: Date, default: Date.now },
    completedAt:     { type: Date },
    durationMs:      { type: Number },
    error:           { type: String },
  },
  { timestamps: false }
);

automationLogSchema.index({ business: 1, automation: 1 });
automationLogSchema.index({ business: 1, createdAt: -1 });
automationLogSchema.index({ business: 1, status: 1 });
// TTL: auto-eliminar logs después de 90 días
automationLogSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AutomationLog', automationLogSchema);
