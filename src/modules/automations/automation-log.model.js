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
// NOTA (documentado en docs/implementation/known-issues.md, no se arregla
// acá): este schema tiene `{timestamps:false}` — `createdAt` no existe en
// ningún documento. Este índice queda huérfano (nunca puede usarse para
// nada) desde que se creó. Fuera de alcance de este PR.
automationLogSchema.index({ business: 1, createdAt: -1 });
automationLogSchema.index({ business: 1, status: 1 });
// Para el cooldown del barrido de triggers de tiempo (Caso 7 del backlog):
// antes de encolar la ejecución de una automatización de tiempo para un
// lead, se consulta "¿ya corrió esto para este lead recientemente?" — sin
// este índice, esa consulta escanearía todos los logs del negocio en cada
// ciclo del barrido. `lead` no es `required` en el schema (algunas
// automatizaciones no están atadas a un lead — ver testAutomation()), pero
// eso no afecta este índice: una query de cooldown siempre filtra por un
// `lead` concreto, así que los documentos con `lead` ausente simplemente
// nunca matchean, no rompen nada.
automationLogSchema.index({ automation: 1, lead: 1, startedAt: -1 });
// TTL: auto-eliminar logs después de 90 días
automationLogSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AutomationLog', automationLogSchema);
