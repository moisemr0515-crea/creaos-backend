const mongoose = require('mongoose');
const { normalizeToE164 } = require('../../utils/phone');
const Pipeline = require('../pipeline/pipeline.model');

const TEMPERATURES = ['cold', 'warm', 'hot'];
const SOURCES = ['manual', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral', 'website', 'csv_import', 'other'];
const ACTIVITY_TYPES = ['created', 'updated', 'stage_changed', 'assigned', 'note_added', 'imported', 'contacted'];

// NOTA: `pipelineStage` ya NO tiene un enum fijo aquí — cada negocio puede
// personalizar completamente los stages de su Pipeline (ver pipeline.model.js),
// así que la validación real de qué valores son válidos se hace de forma
// dinámica contra el Pipeline del negocio (pipeline.service#validarStageEnPipeline),
// no contra una lista hardcodeada.
//
// PIPELINE_STAGES/STAGE_LABELS de abajo se mantienen SOLO como referencia para
// el breakdown fijo del dashboard global de Super Admin (admin/dashboard.service.js),
// que agrega leads de TODOS los negocios y necesita un eje de comparación común.
// NO deben usarse para validar/aceptar o rechazar el pipelineStage de un lead.
//
// Mantenido en sync con pipeline.model.js#DEFAULT_STAGES a propósito — si se
// desincronizan, un lead en una etapa que ya no está acá desaparece en
// silencio de getGlobalLeadsFunnel() (el .map() de abajo solo recorre esta
// lista fija), sin perder el dato, pero sin aparecer en ese gráfico.
const PIPELINE_STAGES = ['new', 'contacted', 'negotiating', 'won', 'lost'];

const STAGE_LABELS = {
  new: 'Nuevo',
  contacted: 'Contactado',
  negotiating: 'Negociando',
  won: 'Ganado',
  lost: 'Perdido',
};

const noteSchema = new mongoose.Schema(
  {
    content: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
  },
  { timestamps: true }
);

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    description: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedByName: String,
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

const adSourceSchema = new mongoose.Schema(
  {
    platform: String,
    campaignId: String,
    adSetId: String,
    adId: String,
    formId: String,
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Email inválido'],
    },
    phone: { type: String, maxlength: 30, trim: true },
    company: { type: String, maxlength: 200, trim: true },
    position: { type: String, maxlength: 100, trim: true },
    temperature: { type: String, enum: TEMPERATURES, default: 'cold' },
    source: { type: String, enum: SOURCES, default: 'manual' },
    tags: [{ type: String, trim: true }],
    pipelineStage: { type: String, trim: true, default: 'new' },
    pipeline: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline' },
    stageChangedAt: Date,
    potentialValue: { type: Number, min: 0, default: 0 },
    // Monto real cobrado al cerrar la venta (pantalla "Cerrar venta" del
    // frontend) — distinto de potentialValue, que es la estimación previa
    // al cierre y sigue existiendo tal cual para leads abiertos. Sin
    // default a propósito: undefined significa "todavía no se confirmó un
    // cierre real", que es distinto de "se cerró en $0". Un lead nunca
    // debería tener este campo seteado si no pasó por una etapa 'won' del
    // pipeline alguna vez (ver reports.service.js#getConversionsReport,
    // que usa actualValue con fallback a potentialValue para leads viejos
    // que se cerraron antes de que este campo existiera).
    actualValue: { type: Number, min: 0 },
    // Bloque 4 de la auditoría Business Brain (§59-60, 20/sep/2026) — guarda
    // de idempotencia de POST /leads/:id/close-sale (lead.service.js#cerrarVenta).
    // null = todavía no se cerró vía ESE endpoint nuevo — un lead movido a
    // 'won' por el flujo viejo (PUT genérico + PUT stage, o por
    // update_lead_stage de la IA) sigue sin este campo, a propósito: no hay
    // ningún dato de qué productos se vendieron que migrar retroactivamente
    // para esos leads. Ver el comentario de cerrarVenta() para el filtro
    // atómico que usa este campo.
    saleClosedAt: { type: Date, default: null },
    // DEPRECADO como fuente de verdad: toda cantidad de dinero se lee en la moneda del NEGOCIO (Business.currency). Los leads
    // antiguos guardan 'USD' por el default que tenía este campo y NO se migraron: por eso nadie debe leer este campo para
    // mostrar un importe. El default pasa a null para no seguir generando valores falsos en los leads nuevos.
    currency: { type: String, default: null, uppercase: true },
    closeProbability: { type: Number, min: 0, max: 100, default: 0 },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToName: String,
    lastContactedAt: Date,
    expectedCloseDate: Date,
    convertedAt: Date,
    notes: [noteSchema],
    activity: [activitySchema],
    whatsappId: String,
    adSource: adSourceSchema,
    isArchived: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    importBatch: String,
    // true si el lead se creó por un canal automático (WhatsApp entrante,
    // automatización) mientras el negocio ya estaba sobre su límite de
    // leads activos del plan — nunca bloquea la creación (ver
    // lead.service.js#notifyIfOverLeadLimit), solo lo marca para poder
    // filtrar/reportar después. Un lead creado manualmente o por
    // importación NUNCA llega a tener este flag en true porque esos dos
    // caminos rechazan la creación antes (bloqueo duro).
    overQuota: { type: Boolean, default: false },
  },
  { timestamps: true }
);

leadSchema.index({ business: 1, createdAt: -1 });
leadSchema.index({ business: 1, pipelineStage: 1 });
leadSchema.index({ business: 1, assignedTo: 1 });
leadSchema.index({ business: 1, temperature: 1 });
leadSchema.index({ business: 1, isDeleted: 1 });
leadSchema.index({ business: 1, tags: 1 });
// Para el barrido de triggers de tiempo (Caso 7 del backlog — ver
// automations/timeTriggers.registry.js): por negocio, encontrar leads
// "stale" (sin contacto hace N días) o "estancados" (sin cambio de etapa
// hace N días) es un filtro por rango de fecha sobre estos 2 campos. Sin
// estos índices, esa query sería un collection scan del negocio completo
// en cada ciclo del barrido — antes de esto, ningún código consultaba
// lastContactedAt/stageChangedAt como filtro (mission.service.js los
// usaba, pero trayendo TODOS los leads del negocio y filtrando en JS, no
// como filtro de Mongo).
leadSchema.index({ business: 1, isDeleted: 1, lastContactedAt: 1 });
leadSchema.index({ business: 1, isDeleted: 1, stageChangedAt: 1 });
leadSchema.index({ name: 'text', email: 'text', phone: 'text', company: 'text' });
// Único parcial (Blueprint §7 paso 7) — promovido desde el índice no-único
// original una vez confirmado que no quedan duplicados activos (Problema 4,
// Paso 2: 0 grupos {business,phone} duplicados en isDeleted:false,
// verificado en producción antes de este cambio). `crearLead()` ya rechaza
// duplicados a nivel de aplicación (409) desde el Paso 1 — este índice es
// la red de seguridad a nivel de base de datos para cualquier otro camino
// de escritura (import, scripts, futuras rutas) que no pase por ahí.
//
// partialFilterExpression solo aplica sobre isDeleted:false + phone de tipo
// string — así, (a) un lead soft-deleted nunca bloquea la creación de un
// lead nuevo con el mismo número (mismo criterio que ya usa crearLead()), y
// (b) leads sin teléfono (campo opcional) quedan fuera del índice — Mongo
// trataría un `phone` ausente/null como el mismo valor "faltante" en todos
// los documentos y los haría chocar entre sí si no se excluyeran acá.
// partialFilterExpression no soporta $ne, así que $type:'string' es la
// forma de excluir missing/null (no excluye '' explícito, pero no hay
// ningún lead con phone:'' en producción hoy — verificado antes de este
// cambio).
//
// Nombre explícito a propósito: el índice viejo no-único de arriba tiene
// las mismas claves {business,phone} y Mongo/Mongoose le asigna el mismo
// nombre autogenerado ("business_1_phone_1") a cualquier índice nuevo con
// esas claves — sin un nombre distinto, Lead.init() falla al arrancar con
// "An existing index has the same name" (confirmado probándolo local antes
// de este commit). Con nombre propio, este índice se crea sin chocar; el
// viejo queda redundante pero inofensivo hasta que se borre aparte
// (ver scripts/drop-old-lead-phone-index.js).
leadSchema.index(
  { business: 1, phone: 1 },
  { name: 'business_1_phone_1_unique_active', unique: true, partialFilterExpression: { isDeleted: false, phone: { $type: 'string' } } }
);

// Normaliza `phone` a E.164 en cada creación/edición nueva — mismo patrón que
// el pre('save') de `slug` en business.model.js. Solo corrige el formato del
// string hacia adelante; no toca documentos ya guardados ni fusiona nada
// (Blueprint §7 paso 4).
leadSchema.pre('save', function (next) {
  if (this.isModified('phone') && this.phone) {
    this.phone = normalizeToE164(this.phone);
  }
  next();
});

// Todo lead NUEVO nace con la probabilidad de cierre de SU etapa, sin importar el camino por el que se creó (manual, WhatsApp,
// Meta/TikTok, automatización, importación): antes solo crearLead() la copiaba y el resto nacía en 0 %, lo que dejaba el "valor
// esperado" en 0 aunque el lead tuviera valor. Un único gancho, en vez de repetir esto en cada creador.
//   - Pipeline: el del lead si es de ESTE negocio y está activo; si no, el pipeline por defecto del negocio; si el negocio no
//     tiene ninguno, las etapas por defecto (sin crearlo: es una lectura). Siempre respeta las etapas propias de cada negocio.
//   - Una probabilidad EXPLÍCITA (incluido 0) se respeta: solo actúa si closeProbability sigue en su valor por defecto.
//   - Solo leads nuevos (isNew): guardar de nuevo un lead existente nunca la toca.
//   - Etapa que no existe en el pipeline, o cualquier fallo al leerlo: queda como estaba (0); nunca bloquea la creación de un lead
//     (un WhatsApp entrante no se puede perder por esto).
// pre('validate') y no pre('save'): también corre con insertMany() (importación), que no ejecuta pre('save').
// shortcut: una consulta de pipeline por lead nuevo; si las importaciones masivas lo notan, cachear por pipeline dentro de la carga.
leadSchema.pre('validate', async function aplicarProbabilidadDeLaEtapa() {
  if (!this.isNew || !this.$isDefault('closeProbability')) return;
  try {
    const campos = 'stages.key stages.defaultProbability';
    const propio = this.pipeline
      ? await Pipeline.findOne({ _id: this.pipeline, business: this.business, isActive: true }, campos).lean()
      : null;
    const pipeline = propio || await Pipeline.findOne({ business: this.business, isDefault: true, isActive: true }, campos).lean();
    const etapa = (pipeline ? pipeline.stages : Pipeline.DEFAULT_STAGES).find((e) => e.key === this.pipelineStage);
    if (etapa && typeof etapa.defaultProbability === 'number') this.closeProbability = etapa.defaultProbability;
  } catch {
    // fail-soft: se queda la probabilidad por defecto
  }
});

leadSchema.virtual('stageLabel').get(function () {
  return STAGE_LABELS[this.pipelineStage] || this.pipelineStage;
});

leadSchema.methods.softDelete = async function (userId, userName) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.activity.push({
    type: 'updated',
    description: 'Lead eliminado',
    performedBy: userId,
    performedByName: userName,
  });
  return this.save();
};

leadSchema.statics.findActive = function (businessId, filter = {}) {
  return this.find({ business: businessId, isDeleted: false, ...filter });
};

module.exports = mongoose.model('Lead', leadSchema);
module.exports.TEMPERATURES = TEMPERATURES;
module.exports.SOURCES = SOURCES;
// Ver nota arriba: solo para el dashboard global de Super Admin, no para validación.
module.exports.PIPELINE_STAGES = PIPELINE_STAGES;
module.exports.STAGE_LABELS = STAGE_LABELS;
