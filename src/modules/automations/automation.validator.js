const Joi = require('joi');
const { TRIGGER_TYPES, ACTION_TYPES } = require('./automation.model');

const OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than'];

const conditionSchema = Joi.object({
  field:    Joi.string().required(),
  operator: Joi.string().valid(...OPERATORS).required(),
  value:    Joi.alternatives().try(Joi.string(), Joi.number(), Joi.boolean()).required(),
});

const actionSchema = Joi.object({
  order:  Joi.number().integer().min(1).required(),
  type:   Joi.string().valid(...ACTION_TYPES).required(),
  config: Joi.object().default({}),
  delay:  Joi.number().integer().min(0).max(86400).default(0),
});

const triggerSchema = Joi.object({
  type:       Joi.string().valid(...TRIGGER_TYPES).required(),
  conditions: Joi.array().items(conditionSchema).default([]),
});

const createAutomationSchema = Joi.object({
  name:        Joi.string().trim().max(200).required(),
  description: Joi.string().max(500).allow('').optional(),
  isActive:    Joi.boolean().default(true),
  trigger:     triggerSchema.required(),
  actions:     Joi.array().items(actionSchema).min(1).required(),
});

const updateAutomationSchema = Joi.object({
  name:        Joi.string().trim().max(200),
  description: Joi.string().max(500).allow(''),
  isActive:    Joi.boolean(),
  trigger:     triggerSchema,
  actions:     Joi.array().items(actionSchema).min(1),
}).min(1);

const listAutomationsSchema = Joi.object({
  isActive:    Joi.boolean(),
  triggerType: Joi.string().valid(...TRIGGER_TYPES),
  page:        Joi.number().integer().min(1).default(1),
  limit:       Joi.number().integer().min(1).max(100).default(20),
});

module.exports = { createAutomationSchema, updateAutomationSchema, listAutomationsSchema };
