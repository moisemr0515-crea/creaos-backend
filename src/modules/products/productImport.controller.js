const productImportService = require('./productImport.service');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito } = require('../../utils/response');

// CREA Product Intelligence™ V1.0 — Etapa 5/10. `req.file` lo pone multer
// (ver product.routes.js) — mismo criterio que import.controller.js
// (Leads): memoria, nunca disco. `req.businessId` viene de injectTenant,
// nunca del body — mismo principio de siempre.
const actor = (req) => ({ _id: req.user._id, name: req.user.name });

const requireFile = (req) => {
  if (!req.file) throw new AppError('Falta el archivo a importar (campo "file")', 400);
  return req.file;
};

const previewImport = async (req, res, next) => {
  try {
    const file = requireFile(req);
    const resultado = await productImportService.previsualizarImportacion(req.businessId, file);
    return respuestaExito(res, { message: 'Vista previa generada', data: resultado });
  } catch (err) {
    next(err);
  }
};

const confirmImport = async (req, res, next) => {
  try {
    const file = requireFile(req);
    const resultado = await productImportService.confirmarImportacion(req.businessId, actor(req), file);
    return respuestaExito(res, { message: 'Importación completada', data: resultado });
  } catch (err) {
    next(err);
  }
};

module.exports = { previewImport, confirmImport };
