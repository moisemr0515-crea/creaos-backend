const { validationResult } = require('express-validator');

/**
 * Middleware que ejecuta los resultados de express-validator.
 * Colócalo después de los esquemas de validación en la ruta.
 *
 * Uso:
 *   router.post('/register', [...validators], validate, controller)
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    // Formatear errores para respuesta legible
    const erroresFormateados = errors.array().map((err) => ({
      campo: err.path,
      mensaje: err.msg,
      valor: err.value,
    }));

    return res.status(422).json({
      success: false,
      message: 'Error de validación en los datos enviados',
      errors: erroresFormateados,
    });
  }

  next();
};

module.exports = { validate };
