const mongoose = require('mongoose');

/**
 * OutboundEvent — Blueprint §4.3, simétrico a InboundEvent. Da trazabilidad
 * al envío de la respuesta automática de la IA vía cola (sub-fase 1.d) —
 * antes de esto, un envío exitoso o fallido solo quedaba en los logs.
 */

// 'skipped': la IA generó la respuesta pero un agente humano tomó control
// (aiEnabled=false) antes de que el outbound worker llegara a mandarla —
// ver outbound.worker.js (hallazgo de code review, sub-fase 1.d).
const STATUSES = [
  'pending',
  'enqueue_failed',
  'queued',
  'processing',
  'sending',
  'retryable_failed',
  'sent',
  'permanently_failed',
  // El proceso cayó durante la llamada externa y no existe confirmación
  // suficiente para reenviar sin riesgo de duplicar en el proveedor.
  'delivery_uncertain',
  // Compatibilidad con eventos creados antes del ciclo durable nuevo.
  'failed',
  'skipped',
];

const outboundEventSchema = new mongoose.Schema(
  {
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    provider: { type: String, default: 'gupshup' },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    // Referencia al InboundEvent que originó esta respuesta automática (solo
    // aplica a respuestas de la IA, no a envíos manuales de un agente —
    // esos no pasan por esta cola). Se usa para idempotencia: si un job de
    // inbound.worker.js se reintenta después de haber generado ya una
    // respuesta, esto permite detectarlo sin volver a llamar a la IA
    // (hallazgo de code review, sub-fase 1.d).
    sourceInboundEvent: { type: mongoose.Schema.Types.ObjectId, ref: 'InboundEvent', default: null },
    to: { type: String, required: true },
    text: { type: String, required: true },
    status: { type: String, enum: STATUSES, default: 'pending' },
    providerMessageId: { type: String, default: null }, // id que devuelve Gupshup al aceptar el envío
    providerStatus: { type: String, default: null },
    providerStatusAt: { type: Date, default: null },
    error: { type: String, default: null },
    errorType: { type: String, default: null },
    attemptCount: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    terminalAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

outboundEventSchema.index({ tenantId: 1, createdAt: -1 });
outboundEventSchema.index({ conversation: 1, createdAt: -1 });
outboundEventSchema.index({ sourceInboundEvent: 1 });

module.exports = mongoose.model('OutboundEvent', outboundEventSchema);
module.exports.STATUSES = STATUSES;
