const mongoose = require('mongoose');

/**
 * InboundEvent — Blueprint §4.3 (Message Gateway). Registro mínimo de cada
 * mensaje entrante procesado por el Inbound Gateway, con `providerMessageId`
 * como índice único: es la clave de idempotencia (§8) — un reintento del
 * mismo mensaje por parte del proveedor no se reprocesa.
 *
 * Extiende el shape mínimo del Blueprint con `tenantId` y `from`/`text`
 * (redundantes con `rawPayload`, pero evitan tener que re-parsear el
 * payload crudo para queries simples como "eventos de este tenant").
 */

const STATUSES = ['received', 'processing', 'processed', 'failed'];

const inboundEventSchema = new mongoose.Schema(
  {
    providerMessageId: { type: String, required: true },
    provider: { type: String, required: true },
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    from: String,
    text: String,
    rawPayload: mongoose.Schema.Types.Mixed,
    status: { type: String, enum: STATUSES, default: 'received' },
    error: { type: String, default: null },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Clave de idempotencia (Blueprint §8) — nunca 2 eventos con el mismo mensaje del proveedor.
inboundEventSchema.index({ providerMessageId: 1 }, { unique: true });
inboundEventSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('InboundEvent', inboundEventSchema);
module.exports.STATUSES = STATUSES;
