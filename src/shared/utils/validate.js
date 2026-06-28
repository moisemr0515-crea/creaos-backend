const { AppError } = require('./AppError');

async function validateBody(schema, body) {
  const { error, value } = schema.validate(body, { abortEarly: false, stripUnknown: true });
  if (error) throw new AppError(error.details.map((d) => d.message).join('; '), 400);
  return value;
}

async function validateQuery(schema, query) {
  const { error, value } = schema.validate(query, { abortEarly: false, stripUnknown: true });
  if (error) throw new AppError(error.details.map((d) => d.message).join('; '), 400);
  return value;
}

module.exports = { validateBody, validateQuery };
