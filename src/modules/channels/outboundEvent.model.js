const mongoose = require('mongoose');

/**
 * OutboundEvent — Blueprint §4.3, simétrico a InboundEvent. Da trazabilidad
 * al envío de la respuesta automática de la IA vía cola (sub-fase 1.d) —
 * antes de esto, un envío exitoso o fallido solo quedaba en los logs.
 */

// 'skipped': la IA generó la respuesta pero un agente humano tomó control
// (aiEnabled=false) antes de que el outbound worker llegara a mandarla —
// ver outbound.worker.js (hallazgo de code review, sub-fase 1.d).
const STATUSES = ['pending', 'processing', 'sent', 'failed', 'skipped'];

const outboundEventSchema = new mongoose.Schema(
  {
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
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
    error: { type: String, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

outboundEventSchema.index({ tenantId: 1, createdAt: -1 });
outboundEventSchema.index({ conversation: 1, createdAt: -1 });
outboundEventSchema.index({ sourceInboundEvent: 1 });

module.exports = mongoose.model('OutboundEvent', outboundEventSchema);
module.exports.STATUSES = STATUSES;
