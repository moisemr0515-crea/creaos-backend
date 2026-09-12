const policyImportService = require('./policyImport.service');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito } = require('../../utils/response');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 9/11.
// Mismo criterio exacto que productImport.controller.js.
const actor = (req) => ({ _id: req.user._id, name: req.user.name });

const requireFile = (req) => {
  if (!req.file) throw new AppError('Falta el archivo a importar (campo "file")', 400);
  return req.file;
};

const previewImport = async (req, res, next) => {
  try {
    const file = requireFile(req);
    const resultado = await policyImportService.previsualizarImportacion(req.businessId, file);
    return respuestaExito(res, { message: 'Vista previa generada', data: resultado });
  } catch (err) {
    next(err);
  }
};

const confirmImport = async (req, res, next) => {
  try {
    const file = requireFile(req);
    const resultado = await policyImportService.confirmarImportacion(req.businessId, actor(req), file);
    return respuestaExito(res, { message: 'Importación completada', data: resultado });
  } catch (err) {
    next(err);
  }
};

module.exports = { previewImport, confirmImport };
