const Joi = require('joi');

const TEMPERATURES = ['cold', 'warm', 'hot'];
const SOURCES = ['manual', 'facebook', 'instagram', 'tiktok', 'whatsapp', 'referral', 'website', 'csv_import', 'other'];
const STAGES = ['new', 'contacted', 'interested', 'proposal', 'negotiation', 'won', 'lost'];

const objectId = Joi.string().hex().length(24);

const createLeadSchema = Joi.object({
  name:              Joi.string().max(200).required(),
  email:             Joi.string().email().lowercase().optional().allow('', null),
  phone:             Joi.string().max(30).optional().allow('', null),
  company:           Joi.string().max(200).optional().allow('', null),
  position:          Joi.string().max(100).optional().allow('', null),
  temperature:       Joi.string().valid(...TEMPERATURES),
  source:            Joi.string().valid(...SOURCES),
  tags:              Joi.array().items(Joi.string().trim()),
  pipelineStage:     Joi.string().valid(...STAGES),
  potentialValue:    Joi.number().min(0),
  currency:          Joi.string().length(3).uppercase(),
  assignedTo:        objectId.optional(),
  expectedCloseDate: Joi.date().iso().optional(),
  note:              Joi.string().max(2000).optional(),
  pipeline:          objectId.optional(),
  adSource: Joi.object({
    platform:   Joi.string(),
    campaignId: Joi.string(),
    adSetId:    Joi.string(),
    adId:       Joi.string(),
    formId:     Joi.string(),
  }).optional(),
});

const updateLeadSchema = Joi.object({
  name:              Joi.string().max(200),
  email:             Joi.string().email().lowercase().allow('', null),
  phone:             Joi.string().max(30).allow('', null),
  company:           Joi.string().max(200).allow('', null),
  position:          Joi.string().max(100).allow('', null),
  temperature:       Joi.string().valid(...TEMPERATURES),
  source:            Joi.string().valid(...SOURCES),
  tags:              Joi.array().items(Joi.string().trim()),
  pipelineStage:     Joi.string().valid(...STAGES),
  potentialValue:    Joi.number().min(0),
  currency:          Joi.string().length(3).uppercase(),
  assignedTo:        objectId.optional().allow(null),
  expectedCloseDate: Joi.date().iso().optional().allow(null),
  lastContactedAt:   Joi.date().iso().optional(),
  closeProbability:  Joi.number().min(0).max(100),
}).min(1);

const addNoteSchema = Joi.object({
  content: Joi.string().max(2000).required(),
});

const changeStageSchema = Joi.object({
  stage:  Joi.string().valid(...STAGES).required(),
  reason: Joi.string().optional().allow('', null),
});

const assignLeadSchema = Joi.object({
  assignedTo: objectId.required(),
});

const listLeadsSchema = Joi.object({
  page:    Joi.number().integer().min(1).default(1),
  limit:   Joi.number().integer().min(1).max(100).default(20),
  search:  Joi.string().max(200).optional().allow(''),
  stage: Joi.alternatives()
    .try(
      Joi.string().valid(...STAGES),
      Joi.array().items(Joi.string().valid(...STAGES))
    )
    .optional(),
  temperature: Joi.alternatives()
    .try(
      Joi.string().valid(...TEMPERATURES),
      Joi.array().items(Joi.string().valid(...TEMPERATURES))
    )
    .optional(),
  source: Joi.alternatives()
    .try(
      Joi.string().valid(...SOURCES),
      Joi.array().items(Joi.string().valid(...SOURCES))
    )
    .optional(),
  assignedTo: Joi.alternatives()
    .try(objectId, Joi.string().valid('unassigned'))
    .optional(),
  tags: Joi.alternatives()
    .try(Joi.string(), Joi.array().items(Joi.string()))
    .optional(),
  sortBy:          Joi.string().valid('createdAt', 'updatedAt', 'name', 'potentialValue', 'stageChangedAt').default('createdAt'),
  sortOrder:       Joi.string().valid('asc', 'desc').default('desc'),
  includeArchived: Joi.boolean().default(false),
  dateFrom:        Joi.date().iso().optional(),
  dateTo:          Joi.date().iso().optional(),
});

const bulkActionSchema = Joi.object({
  leadIds: Joi.array().items(objectId).min(1).max(100).required(),
  action:  Joi.string().valid('delete', 'archive', 'assign', 'change_stage', 'add_tag').required(),
  assignedTo: Joi.when('action', {
    is:        Joi.valid('assign'),
    then:      objectId.required(),
    otherwise: Joi.forbidden(),
  }),
  stage: Joi.when('action', {
    is:        Joi.valid('change_stage'),
    then:      Joi.string().valid(...STAGES).required(),
    otherwise: Joi.forbidden(),
  }),
  tag: Joi.when('action', {
    is:        Joi.valid('add_tag'),
    then:      Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
});

module.exports = {
  createLeadSchema,
  updateLeadSchema,
  addNoteSchema,
  changeStageSchema,
  assignLeadSchema,
  listLeadsSchema,
  bulkActionSchema,
  TEMPERATURES,
  SOURCES,
  STAGES,
};
