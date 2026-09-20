const mongoose = require('mongoose');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1
// (docs/business-brain/CREA_SALES_AI_C2_Business_Brain_Policies_FAQ_V1_Implementation_Spec.md)
// Etapa 2/11 (modelos + validación + índices) — ver
// docs/implementation/c2-policies-faq-current-state.md para el diagnóstico
// y las decisiones confirmadas con el usuario antes de este archivo.
//
// Mismas convenciones ya validadas por CREA Product Intelligence V1.0
// (product.model.js), no las genéricas del documento maestro:
// - Campo de aislamiento multi-tenant: `business` (ObjectId ref
//   'Business'), NUNCA `tenantId` — no existe ningún concepto de "Tenant"
//   distinto de "Business" en este repo hoy (ver auditoría, sección 3.1).
// - `business` es `required` desde el día uno.
const POLICY_CATEGORIES = [
  'payments',
  'shipping_delivery',
  'returns',
  'exchanges',
  'warranty',
  'reservations',
  'financing',
  'cancellations',
  'service_terms',
  'privacy_data',
  'complaints',
  'eligibility',
  'custom_orders',
  'other',
];

const POLICY_TYPES = ['rule', 'restriction', 'requirement', 'exception', 'handoff'];

const RESPONSE_MODES = ['answer', 'ask_clarification', 'handoff', 'deny_action'];

const POLICY_STATUSES = ['draft', 'active', 'archived'];

const POLICY_SOURCES = ['manual', 'import', 'connector', 'migration'];

// Decisión confirmada con el usuario (auditoría, sección 6, decisión #2):
// `scope` en V1 SOLO soporta appliesToAll + productIds (ref real a
// Product) + channelIds (ref real a WhatsAppChannel, Channel Core).
// `serviceIds`/`locationIds`/`customerSegments` del documento maestro NO
// se incluyen ni siquiera como campos reservados sin uso — no existe hoy
// ningún modelo real de Servicio o Ubicación en este repo que referenciar
// (confirmado por grep en la auditoría), y un campo que nadie puede
// poblar con sentido es peor que no tenerlo. Se agregan el día que exista
// ese modelo real.
const scopeSchema = new mongoose.Schema(
  {
    appliesToAll: { type: Boolean, default: true },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    channelIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppChannel' }],
  },
  { _id: false }
);

const actionSchema = new mongoose.Schema(
  {
    responseMode: { type: String, enum: RESPONSE_MODES, default: 'answer' },
    // Obligatorio cuando responseMode:'handoff' — invariante validada en
    // pre('validate') más abajo, no solo documentada.
    handoffReason: { type: String, trim: true, maxlength: 500, default: null },
    requiresHumanApproval: { type: Boolean, default: false },
  },
  { _id: false }
);

const sourceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: POLICY_SOURCES, default: 'manual' },
    reference: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const policySchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    // Identificador natural elegido por el negocio (ej. "RETURNS-001") —
    // único POR NEGOCIO, nunca global (documento §6.2 regla 2: "code
    // único por tenant" → acá, único por business). Mismo patrón que
    // Product.sku.
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 1000, default: null },

    category: { type: String, enum: POLICY_CATEGORIES, required: true },
    policyType: { type: String, enum: POLICY_TYPES, required: true },

    // Texto interno/operativo — lo que usa la IA como fuente de verdad.
    statement: { type: String, required: true, trim: true, maxlength: 4000 },
    // Texto opcional, redactado para el cliente — si no existe, la IA
    // parafrasea `statement` (decisión de prompt, Etapa 6/7, no de este
    // modelo).
    customerFacingText: { type: String, trim: true, maxlength: 4000, default: null },

    scope: { type: scopeSchema, default: () => ({}) },

    action: { type: actionSchema, default: () => ({}) },

    // Documento §6.2 regla 5: entero, rango 0-100. Entre 2 políticas
    // igualmente específicas, gana la de mayor prioridad (Etapa 4).
    priority: {
      type: Number,
      min: 0,
      max: 100,
      default: 50,
      validate: { validator: Number.isInteger, message: 'priority debe ser un entero' },
    },

    // 'draft' nunca se usa para responder al cliente; 'archived' nunca se
    // recupera en retrieval normal (documento §6.2 reglas 7-8) — ambas
    // invariantes se aplican en la capa de retrieval (Etapa 3), NO acá:
    // un modelo no puede impedir que alguien lea un doc 'draft' por
    // accidente si el query no filtra — la garantía real vive en el
    // service, igual que el resto de este repo (ver Product.active,
    // filtrado siempre explícito en cada query, nunca "por convención").
    status: { type: String, enum: POLICY_STATUSES, default: 'draft' },

    effectiveFrom: { type: Date, default: null },
    effectiveUntil: { type: Date, default: null },

    tags: [{ type: String, trim: true, lowercase: true }],

    source: { type: sourceSchema, default: () => ({}) },

    // Documento §6.2 regla 12: cambios relevantes incrementan `version`.
    // El incremento real es responsabilidad del service (Etapa 3) —
    // decidir qué cuenta como "cambio relevante" no es una regla de
    // schema, es una regla de negocio (ej. tocar `statement` sí,
    // reordenar `tags` probablemente no).
    version: { type: Number, default: 1, min: 1 },

    // Bloque 3 de la auditoría Business Brain (§53, 20/sep/2026) —
    // retrieval semántico, capa ADICIONAL sobre el matching textual
    // existente ($text más abajo), nunca en su reemplazo. Se genera en
    // policy.service.js (mismo criterio que pdfSummary en
    // business.service.js: la llamada a la API externa vive en el
    // service, nunca en un hook del modelo) — null si todavía no se
    // generó o si la llamada a OpenAI falló (fail-soft, la Policy sigue
    // siendo encontrable por texto igual).
    embedding: { type: [Number], default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// {business, code} único y estricto — mismo criterio que {business, sku}
// de Product: un `code` no se libera nunca, ni siquiera si la Policy que
// lo usaba se archiva (trazabilidad — documento §29: "archivar en lugar
// de borrar"). Nombre explícito para evitar la colisión de nombre
// autogenerado que ya se documentó en lead.model.js.
policySchema.index({ business: 1, code: 1 }, { unique: true, name: 'business_1_code_1_unique' });
policySchema.index({ business: 1, status: 1, category: 1 });
policySchema.index({ business: 1, priority: 1 });
policySchema.index({ business: 1, effectiveFrom: 1, effectiveUntil: 1 });
// `default_language:'spanish'` — mismo motivo que product.model.js: el
// contenido de política es texto real en español, necesita stemming
// (singular/plural) para que la búsqueda tolere variaciones.
policySchema.index(
  { title: 'text', description: 'text', statement: 'text', customerFacingText: 'text', tags: 'text' },
  { name: 'policy_text_search', default_language: 'spanish' }
);

/**
 * Invariantes de negocio que SÍ pertenecen al modelo (documento §6.2,
 * reglas 6, 9 y 11) — a diferencia de las reglas de "quién puede leer
 * qué" (7, 8), que son de retrieval, estas son estructurales: un
 * documento que las viole nunca debería poder guardarse, sin importar
 * qué código lo escriba.
 */
policySchema.pre('validate', function (next) {
  // Regla 6: si effectiveUntil existe, debe ser posterior a effectiveFrom.
  if (this.effectiveFrom && this.effectiveUntil && this.effectiveUntil <= this.effectiveFrom) {
    this.invalidate('effectiveUntil', 'effectiveUntil debe ser posterior a effectiveFrom');
  }

  // Regla 9: responseMode:'handoff' exige handoffReason.
  if (this.action?.responseMode === 'handoff' && !this.action?.handoffReason) {
    this.invalidate('action.handoffReason', 'action.handoffReason es obligatorio cuando action.responseMode es "handoff"');
  }

  // Regla 11 ("no aceptar appliesToAll=true junto con scopes
  // contradictorios sin una regla explícita") — la regla explícita que
  // fija este PR: appliesToAll:true es mutuamente excluyente con scopes
  // específicos. Si el negocio quiere acotar a productos/canales
  // puntuales, debe poner appliesToAll:false.
  if (this.scope?.appliesToAll && ((this.scope.productIds?.length ?? 0) > 0 || (this.scope.channelIds?.length ?? 0) > 0)) {
    this.invalidate('scope.appliesToAll', 'scope.appliesToAll no puede ser true junto con productIds/channelIds específicos — usa appliesToAll:false para acotar el alcance');
  }

  next();
});

module.exports = mongoose.model('Policy', policySchema);
module.exports.POLICY_CATEGORIES = POLICY_CATEGORIES;
module.exports.POLICY_TYPES = POLICY_TYPES;
module.exports.RESPONSE_MODES = RESPONSE_MODES;
module.exports.POLICY_STATUSES = POLICY_STATUSES;
module.exports.POLICY_SOURCES = POLICY_SOURCES;
