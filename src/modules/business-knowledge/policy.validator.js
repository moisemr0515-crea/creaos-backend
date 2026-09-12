const Joi = require('joi');
const { POLICY_CATEGORIES, POLICY_TYPES, RESPONSE_MODES, POLICY_STATUSES } = require('./policy.model');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11 (CRUD
// API + RBAC). Mismo criterio que product.validator.js: valida la entrada
// HTTP manual — el importador (Etapa 9) reusa estas mismas reglas.
//
// Campos deliberadamente FUERA de estos schemas (Joi + `stripUnknown:true`
// en validateBody los descarta si el cliente los manda igual) — siempre
// los decide el service o el sistema, nunca el cliente HTTP:
// - `business`: sale de req.businessId (injectTenant), nunca del body.
// - `source`: 'manual' en este camino (policy.service.js), 'import' en la
//   Etapa 9 — igual que product.validator.js.
// - `version`/`createdBy`/`updatedBy`: gestionados por policy.service.js.
const objectId = Joi.string().hex().length(24);

const scopeSchema = Joi.object({
  appliesToAll: Joi.boolean(),
  productIds: Joi.array().items(objectId),
  channelIds: Joi.array().items(objectId),
});

const actionSchema = Joi.object({
  responseMode: Joi.string().valid(...RESPONSE_MODES),
  handoffReason: Joi.string().trim().max(500).allow('', null),
  requiresHumanApproval: Joi.boolean(),
});

const policyFields = {
  code: Joi.string().trim().min(1).max(60),
  title: Joi.string().trim().min(3).max(160),
  description: Joi.string().trim().max(1000).allow('', null),
  category: Joi.string().valid(...POLICY_CATEGORIES),
  policyType: Joi.string().valid(...POLICY_TYPES),
  statement: Joi.string().trim().max(4000),
  customerFacingText: Joi.string().trim().max(4000).allow('', null),
  scope: scopeSchema,
  action: actionSchema,
  priority: Joi.number().integer().min(0).max(100),
  status: Joi.string().valid(...POLICY_STATUSES),
  effectiveFrom: Joi.date().allow(null),
  effectiveUntil: Joi.date().allow(null),
  tags: Joi.array().items(Joi.string().trim()),
};

const createPolicySchema = Joi.object({
  ...policyFields,
  code: policyFields.code.required(),
  title: policyFields.title.required(),
  category: policyFields.category.required(),
  policyType: policyFields.policyType.required(),
  statement: policyFields.statement.required(),
});

const updatePolicySchema = Joi.object(policyFields).min(1);

const listPoliciesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().max(200).optional().allow(''),
  category: Joi.string().valid(...POLICY_CATEGORIES).optional(),
  status: Joi.string().valid(...POLICY_STATUSES).optional(),
});

module.exports = {
  createPolicySchema,
  updatePolicySchema,
  listPoliciesSchema,
};
