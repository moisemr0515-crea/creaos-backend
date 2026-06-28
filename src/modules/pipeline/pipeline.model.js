const mongoose = require('mongoose');

const DEFAULT_STAGES = [
  { key: 'new',         name: 'Nuevo',       order: 1, color: '#94a3b8', isWon: false, isLost: false, defaultProbability: 5 },
  { key: 'contacted',   name: 'Contactado',  order: 2, color: '#60a5fa', isWon: false, isLost: false, defaultProbability: 20 },
  { key: 'interested',  name: 'Interesado',  order: 3, color: '#a78bfa', isWon: false, isLost: false, defaultProbability: 40 },
  { key: 'proposal',    name: 'Propuesta',   order: 4, color: '#f59e0b', isWon: false, isLost: false, defaultProbability: 60 },
  { key: 'negotiation', name: 'Negociación', order: 5, color: '#fb923c', isWon: false, isLost: false, defaultProbability: 75 },
  { key: 'won',         name: 'Ganado',      order: 6, color: '#22c55e', isWon: true,  isLost: false, defaultProbability: 100 },
  { key: 'lost',        name: 'Perdido',     order: 7, color: '#ef4444', isWon: false, isLost: true,  defaultProbability: 0 },
];

const stageSchema = new mongoose.Schema(
  {
    key:                { type: String, required: true },
    name:               { type: String, required: true },
    order:              { type: Number, required: true },
    color:              { type: String, match: /^#[0-9a-fA-F]{6}$/ },
    isWon:              { type: Boolean, default: false },
    isLost:             { type: Boolean, default: false },
    defaultProbability: { type: Number, min: 0, max: 100, default: 0 },
  },
  { _id: false }
);

const pipelineSchema = new mongoose.Schema(
  {
    business:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name:        { type: String, required: true, trim: true },
    description: String,
    stages:      [stageSchema],
    isDefault:   { type: Boolean, default: false },
    isActive:    { type: Boolean, default: true },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    stats: {
      totalLeads: { type: Number, default: 0 },
      totalValue: { type: Number, default: 0 },
      wonLeads:   { type: Number, default: 0 },
      wonValue:   { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

pipelineSchema.statics.createDefault = async function (businessId, userId) {
  return this.create({
    business:    businessId,
    name:        'Pipeline Principal',
    description: 'Pipeline de ventas predeterminado',
    stages:      DEFAULT_STAGES,
    isDefault:   true,
    isActive:    true,
    createdBy:   userId,
  });
};

module.exports = mongoose.model('Pipeline', pipelineSchema);
module.exports.DEFAULT_STAGES = DEFAULT_STAGES;
