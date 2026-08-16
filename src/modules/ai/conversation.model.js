const mongoose = require('mongoose');

// Regla de Meta/WhatsApp Business: solo se puede mandar texto libre a un
// contacto si escribió en las últimas 24h; fuera de eso, hay que reabrir con
// una plantilla aprobada. Ver conversationSchema.methods.getWindowState().
const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;

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
    // Imagen/video adjunto — `content` sigue siendo required (queda con el
    // caption si lo hay, o un placeholder tipo "[Imagen]"/"[Video]" si no,
    // para no romper nada que ya lea `content`: resúmenes de IA, contexto
    // de chat, etc.). mediaUrl/mediaType van null en cualquier mensaje sin
    // adjunto — la gran mayoría.
    mediaUrl:  { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', null], default: null },
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
    // Timestamp del último mensaje de WhatsApp ENTRANTE real (del lead, no
    // del agente/IA) — SOLO lo actualizan los flujos que procesan un
    // WhatsApp entrante de verdad (webhook.service.js#processGupshupMessage,
    // inbound.worker.js#ensureLeadAndConversation). Deliberadamente NO lo
    // toca ai.service.js#chat() (usado por sendMessage(), que "simula" lo
    // que dijo el lead para probar la respuesta de la IA sin que haya
    // pasado nada real por WhatsApp) — si lo tocara, la ventana calculada
    // acá quedaría "abierta" en nuestra base sin que Meta la haya abierto
    // de verdad, dando una falsa sensación de cumplimiento.
    lastInboundMessageAt: { type: Date, default: null },
  },
  { timestamps: true }
);

conversationSchema.index({ business: 1, lead: 1 });
conversationSchema.index({ business: 1, status: 1 });
conversationSchema.index({ business: 1, createdAt: -1 });

/**
 * Estado de la ventana de 24h de WhatsApp Business (Meta). Sin ningún
 * mensaje entrante real registrado todavía, la ventana se considera
 * cerrada (no hay base para asumir que se puede mandar texto libre).
 * @returns {{ windowOpen: boolean, windowExpiresAt: Date|null }}
 */
conversationSchema.methods.getWindowState = function () {
  if (!this.lastInboundMessageAt) {
    return { windowOpen: false, windowExpiresAt: null };
  }
  const windowExpiresAt = new Date(this.lastInboundMessageAt.getTime() + WINDOW_DURATION_MS);
  return { windowOpen: windowExpiresAt.getTime() > Date.now(), windowExpiresAt };
};

module.exports = mongoose.model('Conversation', conversationSchema);
module.exports.WINDOW_DURATION_MS = WINDOW_DURATION_MS;
