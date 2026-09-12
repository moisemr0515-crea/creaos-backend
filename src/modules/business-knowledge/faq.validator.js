const Joi = require('joi');
const { FAQ_CATEGORIES, CONFIDENCE_MODES, FAQ_STATUSES } = require('./faq.model');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 5/11. Ver
// policy.validator.js para el criterio compartido (no se repite acá).
//
// `normalizedQuestion` queda deliberadamente fuera de este schema — la
// calcula faq.model.js#pre('validate') a partir de `question`, nunca algo
// que el cliente HTTP pueda declarar directamente.
const objectId = Joi.string().hex().length(24);

const faqScopeSchema = Joi.object({
  appliesToAll: Joi.boolean(),
  channelIds: Joi.array().items(objectId),
});

const faqFields = {
  question: Joi.string().trim().min(3).max(500),
  answer: Joi.string().trim().max(4000),
  category: Joi.string().valid(...FAQ_CATEGORIES),
  aliases: Joi.array().items(Joi.string().trim()),
  keywords: Joi.array().items(Joi.string().trim()),
  tags: Joi.array().items(Joi.string().trim()),
  linkedPolicyIds: Joi.array().items(objectId),
  linkedProductIds: Joi.array().items(objectId),
  scope: faqScopeSchema,
  confidenceMode: Joi.string().valid(...CONFIDENCE_MODES),
  priority: Joi.number().integer().min(0).max(100),
  status: Joi.string().valid(...FAQ_STATUSES),
  effectiveFrom: Joi.date().allow(null),
  effectiveUntil: Joi.date().allow(null),
};

const createFAQSchema = Joi.object({
  ...faqFields,
  question: faqFields.question.required(),
  answer: faqFields.answer.required(),
  category: faqFields.category.required(),
});

const updateFAQSchema = Joi.object(faqFields).min(1);

const listFAQsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().max(200).optional().allow(''),
  category: Joi.string().valid(...FAQ_CATEGORIES).optional(),
  status: Joi.string().valid(...FAQ_STATUSES).optional(),
});

module.exports = {
  createFAQSchema,
  updateFAQSchema,
  listFAQsSchema,
};
