const mongoose = require('mongoose');
const { normalizeToE164 } = require('../../utils/phone');

const TEMPERATURES = ['cold', 'warm', 'hot'];
const SOURCES = ['manual', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral', 'website', 'csv_import', 'other'];
const ACTIVITY_TYPES = ['created', 'updated', 'stage_changed', 'assigned', 'note_added', 'imported', 'contacted'];

// NOTA: `pipelineStage` ya NO tiene un enum fijo aquí — cada negocio puede
// personalizar completamente los stages de su Pipeline (ver pipeline.model.js),
// así que la validación real de qué valores son válidos se hace de forma
// dinámica contra el Pipeline del negocio (pipeline.service#validarStageEnPipeline),
// no contra una lista hardcodeada.
//
// PIPELINE_STAGES/STAGE_LABELS de abajo se mantienen SOLO como referencia para
// el breakdown fijo del dashboard global de Super Admin (admin/dashboard.service.js),
// que agrega leads de TODOS los negocios y necesita un eje de comparación común.
// NO deben usarse para validar/aceptar o rechazar el pipelineStage de un lead.
const PIPELINE_STAGES = ['new', 'contacted', 'interested', 'proposal', 'negotiation', 'won', 'lost'];

const STAGE_LABELS = {
  new: 'Nuevo',
  contacted: 'Contactado',
  interested: 'Interesado',
  proposal: 'Propuesta',
  negotiation: 'Negociación',
  won: 'Ganado',
  lost: 'Perdido',
};

const noteSchema = new mongoose.Schema(
  {
    content: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
  },
  { timestamps: true }
);

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    description: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedByName: String,
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

const adSourceSchema = new mongoose.Schema(
  {
    platform: String,
    campaignId: String,
    adSetId: String,
    adId: String,
    formId: String,
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    phone: { type: String, maxlength: 30, trim: true },
    company: { type: String, maxlength: 200, trim: true },
    position: { type: String, maxlength: 100, trim: true },
    temperature: { type: String, enum: TEMPERATURES, default: 'cold' },
    source: { type: String, enum: SOURCES, default: 'manual' },
    tags: [{ type: String, trim: true }],
    pipelineStage: { type: String, trim: true, default: 'new' },
    pipeline: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline' },
    stageChangedAt: Date,
    potentialValue: { type: Number, min: 0, default: 0 },
    currency: { type: String, default: 'USD', uppercase: true },
    closeProbability: { type: Number, min: 0, max: 100, default: 0 },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: String,
    lastContactedAt: Date,
    expectedCloseDate: Date,
    convertedAt: Date,
    notes: [noteSchema],
    activity: [activitySchema],
    whatsappId: String,
    adSource: adSourceSchema,
    isArchived: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    importBatch: String,
  },
  { timestamps: true }
);

leadSchema.index({ business: 1, createdAt: -1 });
leadSchema.index({ business: 1, pipelineStage: 1 });
leadSchema.index({ business: 1, assignedTo: 1 });
leadSchema.index({ business: 1, temperature: 1 });
leadSchema.index({ business: 1, isDeleted: 1 });
leadSchema.index({ business: 1, tags: 1 });
leadSchema.index({ name: 'text', email: 'text', phone: 'text', company: 'text' });
// No único todavía (Blueprint §7 paso 5) — permite que las queries de "¿ya
// existe este lead?" usen el número ya normalizado, sin bloquear escrituras
// mientras existan duplicados históricos sin revisar (ver §7 pasos 6-7 y
// docs/implementation/fase-0a-contencion-report.md §3.2 — los ~15 duplicados
// de Myrel Company).
leadSchema.index({ business: 1, phone: 1 });

// Normaliza `phone` a E.164 en cada creación/edición nueva — mismo patrón que
// el pre('save') de `slug` en business.model.js. Solo corrige el formato del
// string hacia adelante; no toca documentos ya guardados ni fusiona nada
// (Blueprint §7 paso 4).
leadSchema.pre('save', function (next) {
  if (this.isModified('phone') && this.phone) {
    this.phone = normalizeToE164(this.phone);
  }
  next();
});

leadSchema.virtual('stageLabel').get(function () {
  return STAGE_LABELS[this.pipelineStage] || this.pipelineStage;
});

leadSchema.methods.softDelete = async function (userId, userName) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.activity.push({
    type: 'updated',
    description: 'Lead eliminado',
    performedBy: userId,
    performedByName: userName,
  });
  return this.save();
};

leadSchema.statics.findActive = function (businessId, filter = {}) {
  return this.find({ business: businessId, isDeleted: false, ...filter });
};

module.exports = mongoose.model('Lead', leadSchema);
module.exports.TEMPERATURES = TEMPERATURES;
module.exports.SOURCES = SOURCES;
// Ver nota arriba: solo para el dashboard global de Super Admin, no para validación.
module.exports.PIPELINE_STAGES = PIPELINE_STAGES;
module.exports.STAGE_LABELS = STAGE_LABELS;
