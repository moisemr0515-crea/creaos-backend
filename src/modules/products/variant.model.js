const mongoose = require('mongoose');

// Bloque 4 de la auditoría Business Brain (§61, 20/sep/2026) — Inventario
// avanzado. Ampliación CONSCIENTE de alcance respecto al documento maestro
// original de Product Intelligence (docs/product-intelligence/...md, §42
// "VISIÓN V1.5 — NO IMPLEMENTAR AHORA", que listaba "variantes complejas"
// como pospuesto) — decisión de producto explícita del 20-sep-2026, no un
// error de ese documento.
//
// Top-level, NO embebido en Product — mismo criterio que
// BusinessDocumentChunk (Bloque 3) no vive embebido en BusinessDocument:
// necesita su propio índice único {business, sku} (una variante es un SKU
// real, tan vendible como un Product sin variantes) y actualizar el stock
// de UNA variante no debe competir por lock de documento con el resto del
// array de variantes del mismo producto.
//
// `business` denormalizado (no solo derivable via `product`) — mismo
// motivo que BusinessDocumentChunk: evita un $lookup a Product en el
// camino caliente de check_stock/get_price/reservarStock.
const variantSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },

    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },

    // Sin schema fijo de atributos a propósito — un negocio de ropa usa
    // color/talla, uno de electrónica usa capacidad/color; no hay un
    // vocabulario único razonable a nivel de toda la plataforma. Se valida
    // en el service (no acá) que al menos 1 atributo esté presente.
    attributes: { type: Map, of: String, default: () => new Map() },

    // null cae al del Product padre — MISMO patrón de fallback que ya usa
    // resolverMoneda()/product.price hoy (ver product.service.js).
    price: { type: Number, min: 0, default: null },
    currency: { type: String, trim: true, uppercase: true, default: null },

    // MISMOS 3 campos e invariante que Product (physicalStock/reservedStock/
    // minimumStock) — una variante ES una unidad de inventario real, con
    // las mismas reglas.
    physicalStock: { type: Number, min: 0, default: 0 },
    reservedStock: { type: Number, min: 0, default: 0 },
    minimumStock: { type: Number, min: 0, default: 0 },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Mismo criterio de unicidad estricta que Product.sku (product.model.js) —
// una variante desactivada no libera su SKU, mismo motivo de trazabilidad.
variantSchema.index({ business: 1, sku: 1 }, { unique: true, name: 'business_1_sku_1_unique' });
variantSchema.index({ product: 1, active: 1 });

variantSchema.pre('validate', function (next) {
  if (this.reservedStock > this.physicalStock) {
    this.invalidate('reservedStock', 'El stock reservado no puede ser mayor al stock físico');
  }
  next();
});

// Calculado, nunca persistido — mismo criterio exacto que
// Product.availableStock (product.model.js).
variantSchema.virtual('availableStock').get(function () {
  return this.physicalStock - this.reservedStock;
});

variantSchema.set('toJSON', { virtuals: true });
variantSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Variant', variantSchema);
