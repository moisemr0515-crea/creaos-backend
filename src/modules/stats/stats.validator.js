const Joi = require('joi');

// El formato lo valida Joi; que sea una fecha real y que el rango sea coherente lo valida stats.period.js (400).
const fecha = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': '{{#label}} debe tener el formato AAAA-MM-DD' });

const summaryQuerySchema = Joi.object({
  period: Joi.string().valid('this_month', 'last_month', 'custom').default('this_month'),
  from: fecha.when('period', { is: 'custom', then: Joi.required(), otherwise: Joi.optional() }),
  to: fecha.when('period', { is: 'custom', then: Joi.required(), otherwise: Joi.optional() }),
});

module.exports = { summaryQuerySchema };
