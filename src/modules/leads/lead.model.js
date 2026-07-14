const mongoose = require('mongoose');

const TEMPERATURES = ['cold', 'warm', 'hot'];
const SOURCES = ['manual', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral', 'website', 'csv_import', 'other'];
const PIPELINE_STAGES = ['new', 'contacted', 'interested', 'proposal', 'negotiation', 'won', 'lost'];
const ACTIVITY_TYPES = ['created', 'updated', 'stage_changed', 'assigned', 'note_added', 'imported', 'contacted'];

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
    pipelineStage: { type: String, enum: PIPELINE_STAGES, default: 'new' },
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
module.exports.PIPELINE_STAGES = PIPELINE_STAGES;
module.exports.STAGE_LABELS = STAGE_LABELS;
