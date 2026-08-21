const Joi = require('joi');
const { PLATFORMS } = require('./push.model');

const registerTokenSchema = Joi.object({
  token:    Joi.string().trim().min(10).required(),
  platform: Joi.string().valid(...PLATFORMS).default('android'),
  deviceId: Joi.string().trim().max(200).allow(null, '').optional(),
});

const unregisterTokenSchema = Joi.object({
  token: Joi.string().trim().min(10).required(),
});

module.exports = { registerTokenSchema, unregisterTokenSchema };
