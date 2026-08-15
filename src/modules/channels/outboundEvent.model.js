const mongoose = require('mongoose');

/**
 * OutboundEvent — Blueprint §4.3, simétrico a InboundEvent. Da trazabilidad
 * al envío de la respuesta automática de la IA vía cola (sub-fase 1.d) —
 * antes de esto, un envío exitoso o fallido solo quedaba en los logs.
 */

const STATUSES = ['pending', 'processing', 'sent', 'failed'];

const outboundEventSchema = new mongoose.Schema(
  {
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
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

module.exports = mongoose.model('OutboundEvent', outboundEventSchema);
module.exports.STATUSES = STATUSES;
