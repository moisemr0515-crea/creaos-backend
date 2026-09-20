const mongoose = require('mongoose');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 2/11. Ver
// policy.model.js para las convenciones compartidas (business, no
// tenantId; scope acotado a la decisión #2 de la auditoría) — no se
// repiten acá los comentarios ya explicados ahí.
const FAQ_CATEGORIES = [
  'business',
  'products',
  'services',
  'payments',
  'delivery',
  'returns',
  'warranty',
  'schedule',
  'location',
  'requirements',
  'support',
  'other',
];

const CONFIDENCE_MODES = ['strict', 'normal'];

const FAQ_STATUSES = ['draft', 'active', 'archived'];

const FAQ_SOURCES = ['manual', 'import', 'connector', 'migration'];

// FAQ.scope NO incluye productIds a propósito (a diferencia de
// Policy.scope) — el documento maestro (§7) ya separa "a qué producto
// aplica" (`linkedProductIds`, más abajo) de "scope" (dónde/por qué canal
// aplica). channelIds sí es real (WhatsAppChannel, Channel Core);
// locationIds queda fuera de V1 (decisión #2, mismo motivo que en Policy:
// no existe un modelo real de Ubicación en este repo).
const faqScopeSchema = new mongoose.Schema(
  {
    appliesToAll: { type: Boolean, default: true },
    channelIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel' }],
  },
  { _id: false }
);

const faqSourceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: FAQ_SOURCES, default: 'manual' },
    reference: { type: String, trim: true, default: null },
  },
  { _id: false }
);

// Rango Unicode de marcas diacríticas combinantes (U+0300–U+036F, en
// decimal 768–879) — usado para pelar acentos después de
// String.prototype.normalize('NFD'). Se implementa con codePointAt() en
// vez de un literal de regex /[̀-ͯ]/ a propósito: escribir ese
// escape literal en este archivo se corrompe de forma reproducible al
// guardarlo (confirmado con una prueba dedicada antes de este commit) —
// mismo tipo de problema ya resuelto en productImport.service.js, pero
// esta vez evitado de raíz en lugar de parcheado después.
const RANGO_DIACRITICOS_MIN = 768;
const RANGO_DIACRITICOS_MAX = 879;

const quitarDiacriticos = (str) =>
  str
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code < RANGO_DIACRITICOS_MIN || code > RANGO_DIACRITICOS_MAX;
    })
    .join('');

/**
 * Normalización determinista de preguntas (documento §8): minúsculas,
 * trim, quita acentos, quita signos de interrogación/exclamación de
 * apertura y cierre (nunca del medio — no rompe "10x20 m" ni "S/ 50"),
 * colapsa espacios duplicados. NO destruye números, porcentajes, nombres
 * de producto ni monedas — ver los ejemplos exactos del documento §8.
 * Exportada para que knowledgeRetrieval.service.js (Etapa 3) normalice la
 * pregunta entrante del lead con el MISMO criterio antes de buscar contra
 * `normalizedQuestion` — nunca duplicar esta lógica en 2 lugares.
 */
const normalizarPregunta = (str) => {
  const base = String(str || '').trim().toLowerCase().normalize('NFD');
  const sinAcentos = quitarDiacriticos(base);
  return sinAcentos
    .replace(/^[¿¡]+/, '')
    .replace(/[?!¿¡]+$/, '')
    .trim()
    .replace(/\s+/g, ' ');
};

/** Dedupea un array de strings ya normalizados (trim+lowercase por el schema), preservando el orden de primera aparición. */
const dedupear = (arr) => [...new Set(arr)];

const faqSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    question: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    // Calculada en pre('validate') a partir de `question` — nunca se
    // escribe a mano desde fuera del modelo. No es `unique` (decisión
    // confirmada #4: 2 preguntas que normalizan igual son válidas, se
    // desambiguan por prioridad en el retrieval, no se rechazan acá).
    normalizedQuestion: { type: String, trim: true, lowercase: true, default: null },
    answer: { type: String, required: true, trim: true, maxlength: 4000 },

    category: { type: String, enum: FAQ_CATEGORIES, required: true },

    aliases: [{ type: String, trim: true, lowercase: true }],
    keywords: [{ type: String, trim: true, lowercase: true }],
    tags: [{ type: String, trim: true, lowercase: true }],

    // Documento §7: linked* son referencias directas, no "scope" — una
    // FAQ puede apoyarse en 0 o más Policies/Products específicos sin que
    // eso cambie a quién le aplica la FAQ en sí (eso lo decide `scope`).
    linkedPolicyIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Policy' }],
    linkedProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],

    scope: { type: faqScopeSchema, default: () => ({}) },

    confidenceMode: { type: String, enum: CONFIDENCE_MODES, default: 'normal' },

    priority: {
      type: Number,
      min: 0,
      max: 100,
      default: 50,
      validate: { validator: Number.isInteger, message: 'priority debe ser un entero' },
    },

    // Mismo criterio que Policy.status — 'draft'/'archived' se excluyen en
    // la capa de retrieval (Etapa 3), no acá.
    status: { type: String, enum: FAQ_STATUSES, default: 'draft' },

    effectiveFrom: { type: Date, default: null },
    effectiveUntil: { type: Date, default: null },

    source: { type: faqSourceSchema, default: () => ({}) },

    version: { type: Number, default: 1, min: 1 },

    // Bloque 3 de la auditoría Business Brain (§53, 20/sep/2026) — mismo
    // criterio exacto que Policy.embedding (ver policy.model.js): capa
    // adicional sobre el matching textual, generada en faq.service.js,
    // fail-soft (null si falló o no se generó todavía).
    embedding: { type: [Number], default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// {business, normalizedQuestion} — índice NORMAL, deliberadamente NO
// único (decisión confirmada #4: un error duro acá sería intolerante con
// cómo la gente realmente carga contenido — variaciones/duplicados de la
// misma pregunta son normales, se resuelven por prioridad en el
// retrieval, no se rechazan al guardar).
faqSchema.index({ business: 1, normalizedQuestion: 1 });
faqSchema.index({ business: 1, status: 1, category: 1 });
faqSchema.index({ business: 1, priority: 1 });
faqSchema.index(
  { question: 'text', aliases: 'text', keywords: 'text', answer: 'text' },
  { name: 'faq_text_search', default_language: 'spanish' }
);

/**
 * Documento §7.1: normaliza `question`→`normalizedQuestion` en cada
 * creación/edición (mismo momento que el pre('save') de `phone` en
 * lead.model.js), dedupea aliases/keywords/tags, y valida la vigencia —
 * mismo invariante que policy.model.js, repetido acá a propósito en vez
 * de compartido entre archivos: cada modelo queda autocontenido, igual
 * que el resto de este repo (ningún otro par de modelos comparte un
 * validador cruzado).
 */
faqSchema.pre('validate', function (next) {
  if (this.isModified('question')) {
    this.normalizedQuestion = normalizarPregunta(this.question);
  }

  if (this.aliases?.length) this.aliases = dedupear(this.aliases);
  if (this.keywords?.length) this.keywords = dedupear(this.keywords);
  if (this.tags?.length) this.tags = dedupear(this.tags);

  if (this.effectiveFrom && this.effectiveUntil && this.effectiveUntil <= this.effectiveFrom) {
    this.invalidate('effectiveUntil', 'effectiveUntil debe ser posterior a effectiveFrom');
  }

  next();
});

module.exports = mongoose.model('FAQ', faqSchema);
module.exports.FAQ_CATEGORIES = FAQ_CATEGORIES;
module.exports.CONFIDENCE_MODES = CONFIDENCE_MODES;
module.exports.FAQ_STATUSES = FAQ_STATUSES;
module.exports.FAQ_SOURCES = FAQ_SOURCES;
module.exports.normalizarPregunta = normalizarPregunta;
