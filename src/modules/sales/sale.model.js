const mongoose = require('mongoose');

// Registro ÚNICO de ventas: Estadísticas lee "Vendido" solo de aquí, y la v5.0 (medio de pago dentro de CREA OS) escribirá
// en la misma colección. Deliberadamente mínimo: sin reembolsos, vendedor ni productos (el lead los tiene).
//   - origin: de dónde salió la venta (cierre manual, propuesta de la IA, comprobante de pago leído, pago dentro de CREA OS).
//   - status: 'pending' = por confirmar (todavía sin fecha de cierre) · 'confirmed' = venta real.
//   - closedAt: fecha de cierre. Es lo que usa Estadísticas para decir en qué periodo se vendió.
//   - currency: copia de Business.currency al registrar. Si el negocio cambia de moneda, las ventas viejas conservan la suya.
//   - ref: identificador externo opcional (id de un pago, número de operación). Único por negocio: un reintento de webhook
//     no puede duplicar la venta.
const ORIGINS = ['manual', 'ai_proposal', 'receipt', 'crea_pay'];
const STATUSES = ['pending', 'confirmed'];

const saleSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: null, match: /^[A-Z]{3}$/ },
    origin: { type: String, enum: ORIGINS, required: true },
    status: { type: String, enum: STATUSES, required: true },
    closedAt: { type: Date, default: null },
    ref: { type: String, trim: true, maxlength: 200, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Una venta confirmada siempre tiene fecha de cierre; una por confirmar no la tiene todavía.
saleSchema.pre('validate', function exigirFechaDeCierre(next) {
  if (this.status === 'confirmed' && !this.closedAt) {
    this.invalidate('closedAt', 'Una venta confirmada necesita fecha de cierre');
  }
  if (this.status === 'pending' && this.closedAt) {
    this.invalidate('closedAt', 'Una venta por confirmar no tiene fecha de cierre todavía');
  }
  next();
});

// Estadísticas: vendido confirmado por negocio y periodo.
saleSchema.index({ business: 1, status: 1, closedAt: -1 });
// Ventas de un lead; también la base de "ganados sin monto".
saleSchema.index({ business: 1, lead: 1 });
// Idempotencia por referencia externa (solo cuando hay ref).
saleSchema.index({ business: 1, ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: 'string' } } });

module.exports = mongoose.model('Sale', saleSchema);
module.exports.ORIGINS = ORIGINS;
module.exports.STATUSES = STATUSES;
