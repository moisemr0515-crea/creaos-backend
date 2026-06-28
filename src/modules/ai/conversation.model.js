const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    role:      { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content:   { type: String, required: true, maxlength: 4000 },
    timestamp: { type: Date, default: Date.now },
    tokens:    Number,
    metadata:  mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const leadQualificationSchema = new mongoose.Schema(
  {
    score:       { type: Number, min: 0, max: 100 },
    temperature: { type: String, enum: ['cold', 'warm', 'hot'] },
    intent:      { type: String, enum: ['buying', 'researching', 'not_interested', 'unknown'] },
    budget:      String,
    timeline:    String,
    notes:       String,
    qualifiedAt: Date,
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    business:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    lead:       { type: mongoose.Schema.Types.ObjectId, ref: 'Lead',     required: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    channel:    { type: String, enum: ['whatsapp', 'web', 'email', 'manual'], default: 'manual' },
    status:     { type: String, enum: ['active', 'waiting', 'resolved', 'escalated'], default: 'active' },
    messages:   [messageSchema],
    aiEnabled:  { type: Boolean, default: true },
    escalatedAt: Date,
    resolvedAt:  Date,
    summary:    String,
    leadQualification: leadQualificationSchema,
    totalTokensUsed: { type: Number, default: 0 },
    isDeleted:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

conversationSchema.index({ business: 1, lead: 1 });
conversationSchema.index({ business: 1, status: 1 });
conversationSchema.index({ business: 1, createdAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
