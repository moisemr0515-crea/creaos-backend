/**
 * Respuesta de éxito estándar.
 * @param {import('express').Response} res
 * @param {object} opciones
 */
const respuestaExito = (res, { statusCode = 200, message = 'OK', data = null, meta = null } = {}) => {
  const cuerpo = {
    success: true,
    message,
  };

  if (data !== null) cuerpo.data = data;
  if (meta !== null) cuerpo.meta = meta;

  return res.status(statusCode).json(cuerpo);
};

/**
 * Respuesta de error estándar.
 * @param {import('express').Response} res
 * @param {object} opciones
 */
const respuestaError = (res, { statusCode = 500, message = 'Error interno del servidor', errors = null } = {}) => {
  const cuerpo = {
    success: false,
    message,
  };

  if (errors !== null) cuerpo.errors = errors;

  return res.status(statusCode).json(cuerpo);
};

/**
 * Construye el objeto meta para respuestas paginadas.
 */
const buildMeta = ({ page, limit, total }) => ({
  page: parseInt(page, 10),
  limit: parseInt(limit, 10),
  total,
  totalPages: Math.ceil(total / limit),
});

module.exports = { respuestaExito, respuestaError, buildMeta };
