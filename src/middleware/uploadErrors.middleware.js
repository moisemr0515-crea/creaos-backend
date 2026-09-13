const multer = require('multer');
const { AppError } = require('./error.middleware');

/**
 * Envuelve un middleware de multer (`upload.single('campo')`/`upload.array(...)`)
 * para traducir sus errores NATIVOS (`multer.MulterError`) a un `AppError`
 * con `statusCode` correcto, antes de que lleguen al manejador global de
 * errores (`error.middleware.js#errorHandler`).
 *
 * Hallazgo real (auditoría de "Archivos del negocio", 12/sep/2026): un
 * `MulterError` no tiene `.statusCode` — `errorHandler` lo trata como un
 * 500 genérico, con el mensaje en inglés que Multer arroja por defecto
 * ("File too large"). Afecta por igual a los 4 campos de archivo (logo,
 * PDF informativo, video de presentación, brochure) — el chequeo de
 * tamaño client-side ya existente cubre el caso normal, esto cubre cuando
 * ese chequeo se rodea o falla (llamada directa a la API, discrepancia de
 * límites).
 *
 * Errores que YA llegan como `AppError` (ej. `fileFilter()` rechazando un
 * tipo de archivo no permitido — ver business.routes.js) pasan tal cual,
 * sin envolver: ya tienen su `statusCode`/mensaje correctos desde antes de
 * este middleware, y no son instancia de `multer.MulterError`.
 *
 * @param {import('express').RequestHandler} middlewareMulter - resultado de `multer(...).single('campo')` o `.array('campo', n)`
 * @param {{ campoLegible: string, limiteLegible: string }} opciones - para armar "El archivo excede el límite de {limiteLegible} para {campoLegible}"
 * @returns {import('express').RequestHandler}
 */
const traducirErroresDeMulter = (middlewareMulter, { campoLegible, limiteLegible }) => (req, res, next) => {
  middlewareMulter(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(`El archivo excede el límite de ${limiteLegible} para ${campoLegible}.`, 413));
      }
      // Cualquier otro código de Multer (LIMIT_UNEXPECTED_FILE,
      // LIMIT_FILE_COUNT, etc.) — mismo criterio: nunca un 500 genérico,
      // aunque no tengamos un mensaje a medida para ese código puntual.
      return next(new AppError(`No se pudo procesar el archivo: ${err.message}`, 400));
    }

    // No es un MulterError — típicamente el AppError que ya lanza
    // fileFilter() (tipo de archivo no permitido). Se propaga tal cual.
    next(err);
  });
};

module.exports = { traducirErroresDeMulter };
