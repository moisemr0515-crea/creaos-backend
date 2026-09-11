const mongoose = require('mongoose');

// CREA Product Intelligence™ V1.0 (docs/product-intelligence/CREA_Product_Intelligence_V1_Documento_Maestro_Claude_Code.md)
// Etapa 2/10 (modelo + service) — ver diagnóstico previo a este PR. Notas de
// diseño que se apartan a propósito de los ejemplos genéricos del documento
// maestro, para seguir las convenciones YA VALIDADAS del resto del proyecto:
//
// - El campo de aislamiento multi-tenant se llama `business` (ObjectId ref
//   'Business'), NO `tenant_id` como usa el documento — es el nombre que
//   usan TODOS los modelos tenant-scoped existentes (Lead, Conversation,
//   Pipeline, Import). Introducir `tenant_id` acá rompería esa convención
//   sin ninguna ganancia real, y complicaría reusar el patrón multi-tenant
//   del Channel Core (que también resuelve `business`, nunca `tenant_id`).
// - A diferencia de `Conversation.tenantId` (deliberadamente opcional hoy,
//   migración en curso, ver conversation.model.js), `business` acá es
//   `required` desde el día uno — no hay ninguna razón para replicar esa
//   deuda técnica en un modelo nuevo.
const PRODUCT_TYPES = ['product', 'service'];
const PRODUCT_SOURCES = ['manual', 'import'];

const productSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000, default: null },
    category: { type: String, trim: true, default: null },
    brand: { type: String, trim: true, default: null },
    // No existe en el documento maestro (que solo distingue vía
    // `track_inventory`) — se agrega para poder responder "NUNCA responder
    // 'agotado' a un servicio solo porque stock=0" (§17) sin adivinarlo a
    // partir de otros campos. `trackInventory` sigue siendo el campo que
    // realmente decide el comportamiento de check_stock(); `productType`
    // es solo informativo/UI por ahora (V1 no acopla ambos campos: un
    // service con trackInventory:true sigue siendo válido, ej. alquiler de
    // equipos con unidades limitadas).
    productType: { type: String, enum: PRODUCT_TYPES, default: 'product' },

    active: { type: Boolean, default: true },

    price: { type: Number, min: 0, default: null },
    // Sin default fijo a propósito (ni 'PEN' ni 'MXN' hardcodeado) — si es
    // null, product.service.js#resolverMoneda() cae a `business.currency`
    // en tiempo de lectura (get_price()/search_products()). Fijar acá un
    // default de esquema congelaría la moneda del producto al valor que
    // tuviera business.currency en el momento de la creación, y dejaría de
    // seguir cambios posteriores en la configuración del negocio.
    currency: { type: String, trim: true, uppercase: true, default: null },

    trackInventory: { type: Boolean, default: true },
    physicalStock: { type: Number, min: 0, default: 0 },
    // Preparado para V1.5 (reservas reales) — V1 no tiene ningún flujo que
    // escriba este campo todavía (fuera de alcance, doc §3/§42), pero
    // availableStock ya lo resta desde ahora para no tener que migrar el
    // cálculo después.
    reservedStock: { type: Number, min: 0, default: 0 },
    minimumStock: { type: Number, min: 0, default: 0 },

    keywords: [{ type: String, trim: true, lowercase: true }],
    synonyms: [{ type: String, trim: true, lowercase: true }],

    source: { type: String, enum: PRODUCT_SOURCES, default: 'manual' },
  },
  { timestamps: true }
);

// {business, sku} único y estricto — sin partialFilterExpression (a
// diferencia de Lead.phone). Confirmado con el usuario: un producto
// desactivado NUNCA libera su SKU para uno nuevo; un lote nuevo del mismo
// código es inventario distinto y debe ser un registro nuevo (motivo:
// trazabilidad de precio/stock histórico del lote desactivado). "Producto
// desactivado" se modela con `active:false`, no con un soft-delete
// separado — no hay ningún flujo en V1 que oculte un producto de las
// pantallas de gestión manual (§9: "no borrar información que pueda ser
// necesaria para trazabilidad"), y no introducir un segundo booleano
// (isDeleted) evita el caso ambiguo "isDeleted:true pero active:true" que
// no tendría ningún significado en este dominio.
productSchema.index({ business: 1, sku: 1 }, { unique: true, name: 'business_1_sku_1_unique' });
productSchema.index({ business: 1, active: 1 });
productSchema.index({ business: 1, category: 1 });
// `default_language: 'spanish'` (a diferencia del índice de texto de Lead,
// que no lo especifica) — necesario acá porque §14 del documento maestro
// exige tolerar singular/plural en la búsqueda de productos ("pastillas"
// debe encontrar "pastilla"), y el stemmer por default de MongoDB es
// inglés. No se toca el índice de Lead (fuera de alcance de este PR, y el
// texto ahí es nombres/emails/empresas, no vocabulario de catálogo con el
// mismo requisito de stemming).
productSchema.index(
  { name: 'text', description: 'text', category: 'text', brand: 'text', keywords: 'text', synonyms: 'text' },
  { name: 'product_text_search', default_language: 'spanish' }
);

// Invariante de negocio (documento maestro §5.1: "evitar stocks negativos").
// `reservedStock` no tiene todavía ningún flujo real que lo escriba en V1
// (ver nota arriba), pero la validación queda desde ya para que availableStock
// (virtual, abajo) nunca pueda ser negativo sin importar qué camino de
// escritura futuro toque este campo.
productSchema.pre('validate', function (next) {
  if (this.reservedStock > this.physicalStock) {
    this.invalidate('reservedStock', 'El stock reservado no puede ser mayor al stock físico');
  }
  next();
});

// Calculado, nunca persistido (documento maestro §5.1: "available_stock
// debería ser calculado, no de escritura manual") — evita por completo la
// clase de bug "se actualizó physicalStock pero alguien olvidó recalcular
// availableStock a mano en otro código".
productSchema.virtual('availableStock').get(function () {
  return this.physicalStock - this.reservedStock;
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);
module.exports.PRODUCT_TYPES = PRODUCT_TYPES;
module.exports.PRODUCT_SOURCES = PRODUCT_SOURCES;
