const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    role:      { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content:   { type: String, required: true, maxlength: 4000 },
    timestamp: { type: Date, default: Date.now },
    tokens:    Number,
    metadata:  mongoose.Schema.Types.Mixed,
    // Quién escribió este mensaje — independiente de `role` (que sigue
    // siendo el eje user/assistant/system que consume OpenAI como contexto
    // de conversación). Un mensaje de agente humano queda con
    // role:'assistant' (para que la IA lo vea como turno propio si retoma
    // la conversación después) + sentBy:'agent', para poder distinguirlo en
    // UI/reportes sin tocar el enum de `role`.
    sentBy: { type: String, enum: ['ai', 'agent', 'system'], default: 'ai' },
    // Estado del envío real por WhatsApp de ESTE mensaje puntual — no de la
    // conversación entera, porque una misma conversación puede tener
    // mensajes que sí intentaron salir por WhatsApp y otros que no (ej. un
    // mensaje interno en una conversación de canal 'manual').
    whatsappStatus: { type: String, enum: ['sent', 'failed', 'not_applicable'], default: 'not_applicable' },
    whatsappError:  { type: String, default: null },
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
    // Tenant real (Decisión 1 del Implementation Blueprint, §5.1 PR A) — todavía
    // OPCIONAL a propósito. Único caso de esta migración que toca una colección
    // con datos existentes: se agrega sin required para no exigir backfill
    // inmediato (cero downtime). El backfill (PR B) y el endurecimiento a
    // required:true (PR C) son pasos separados y posteriores, no parte de esta
    // sub-fase. Cualquier código nuevo que use este campo debe tratarlo como
    // potencialmente ausente hasta que PR C se complete.
    tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: false, index: true },
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
