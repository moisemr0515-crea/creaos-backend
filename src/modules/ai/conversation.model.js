const mongoose = require('mongoose');

// Regla de Meta/WhatsApp Business: solo se puede mandar texto libre a un
// contacto si escribió en las últimas 24h; fuera de eso, hay que reabrir con
// una plantilla aprobada. Ver conversationSchema.methods.getWindowState().
const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;

const messageSchema = new mongoose.Schema(
  {
    // 'tool' agregado para function calling real (ver ai/tools/index.js +
    // ai.service.js#generateReply()): un mensaje role:'tool' es el
    // RESULTADO de ejecutar una tool que el modelo pidió invocar, y se le
    // manda de vuelta a OpenAI como parte del contexto para que complete su
    // respuesta — mismo rol que usa la API de OpenAI para esto.
    role:      { type: String, enum: ['user', 'assistant', 'system', 'tool'], required: true },
    // Ya NO es required:true (lo era antes de este cambio) — un mensaje
    // role:'assistant' que SOLO pide tool_calls (sin texto todavía) viene
    // de OpenAI con content:null, y Mongoose rechaza '' como si fuera
    // "ausente" en un String required:true (a diferencia de otros tipos).
    // default:'' cubre ese único caso; para el resto de mensajes (la
    // inmensa mayoría) sigue siendo, en la práctica, siempre no-vacío
    // porque quien los crea siempre les pasa contenido real. Ver
    // generateReply().
    content:   { type: String, default: '', maxlength: 4000 },
    timestamp: { type: Date, default: Date.now },
    tokens:    Number,
    metadata:  mongoose.Schema.Types.Mixed,
    // Los siguientes 3 campos solo se usan en mensajes relacionados a tool
    // calling — quedan null/undefined en el resto (la inmensa mayoría) de
    // mensajes, que no cambian de forma en absoluto.
    //
    // toolCalls: en un mensaje role:'assistant' que pidió invocar una o más
    // tools, la lista tal cual la devolvió OpenAI
    // (`completion.choices[0].message.tool_calls`) — se guarda sin
    // transformar, para poder auditar/reproducir exactamente qué pidió el
    // modelo.
    toolCalls: { type: mongoose.Schema.Types.Mixed, default: null },
    // toolCallId: en un mensaje role:'tool' (el resultado), el id del
    // tool_call específico que está respondiendo — OpenAI lo requiere para
    // emparejar la respuesta con el pedido en el siguiente turno.
    toolCallId: { type: String, default: null },
    // name: en un mensaje role:'tool', el nombre de la tool ejecutada (ej.
    // 'escalate_to_human') — no lo exige la API, pero sin esto un mensaje
    // role:'tool' es ilegible en la UI/DB sin cruzarlo con el toolCallId del
    // mensaje anterior.
    name: { type: String, default: null },
    // Quién escribió este mensaje — independiente de `role` (que sigue
    // siendo el eje user/assistant/system que consume OpenAI como contexto
    // de conversación). Un mensaje de agente humano queda con
    // role:'assistant' (para que la IA lo vea como turno propio si retoma
    // la conversación después) + sentBy:'agent', para poder distinguirlo en
    // UI/reportes sin tocar el enum de `role`.
    //
    // 'lead' agregado a propósito (hallazgo real, no hipotético): un
    // mensaje entrante del lead (role:'user') nunca seteaba sentBy
    // explícito, así que cada uno quedaba con el default 'ai' — mismo
    // valor que una respuesta real de la IA. `role:'user'` ya lo distingue
    // sin ambigüedad de los mensajes salientes, pero dejar sentBy:'ai' en
    // un mensaje del lead es semánticamente incorrecto y confunde a
    // cualquier consumidor (UI, reportes) que mire sentBy sin filtrar por
    // role primero. Ver ai.service.js#saveInboundMessage().
    sentBy: { type: String, enum: ['ai', 'agent', 'lead', 'system'], default: 'ai' },
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
