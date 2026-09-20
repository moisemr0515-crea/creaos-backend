const mongoose = require('mongoose');

// Bloque 4 de la auditoría Business Brain (§59, 20/sep/2026) — Inventario
// avanzado. Ampliación CONSCIENTE de alcance respecto al documento maestro
// original de Product Intelligence (§42 "VISIÓN V1.5 — NO IMPLEMENTAR
// AHORA", que listaba "reservas" como pospuesto) — decisión de producto
// explícita del 20-sep-2026, no un error de ese documento.
//
// Top-level, mismo criterio que Variant (hermano de este archivo): una
// reserva es un evento con vida propia (se crea, vence o se confirma en
// momentos distintos) — no un subdocumento embebido en Product/Variant, que
// competiría por lock de documento con actualizaciones de stock de otras
// reservas del mismo producto.
const RESERVATION_STATUSES = ['active', 'confirmed', 'released', 'expired'];

const stockReservationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    // null = el producto NO tiene variantes (hasVariants:false) y la
    // reserva apunta directo al stock del Product — mismo patrón de
    // "variant|null" que ya resuelve resolverVariante() en
    // product.service.js para stock/precio.
    variant: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant', default: null },
    // null = reserva creada fuera del flujo de un lead puntual (ej. desde
    // el panel de admin) — el caso real hoy (Fase 3, punto 3) siempre la
    // asocia a un lead, pero el modelo no lo exige a nivel de esquema.
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },

    quantity: { type: Number, required: true, min: 1 },

    status: { type: String, enum: RESERVATION_STATUSES, default: 'active', index: true },

    // Cuándo vence sola si nadie la confirma ni la libera antes — el sweep
    // de BullMQ (stockReservationSweep.worker.js) consulta por este campo.
    expiresAt: { type: Date, required: true, index: true },

    confirmedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// El sweep filtra {status:'active', expiresAt: {$lte: now}} — índice
// compuesto para que ese barrido no escanee reservas ya resueltas.
stockReservationSchema.index({ status: 1, expiresAt: 1 });
stockReservationSchema.index({ business: 1, product: 1, variant: 1, status: 1 });

module.exports = mongoose.model('StockReservation', stockReservationSchema);
module.exports.RESERVATION_STATUSES = RESERVATION_STATUSES;
