const importService = require('./import.service');
const { respuestaExito, buildMeta } = require('../../utils/response');
const { AppError } = require('../../middleware/error.middleware');

const uploadImport = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Se requiere un archivo CSV o XLSX', 400);

    let columnMapping = {};
    if (req.body.columnMapping) {
      try {
        columnMapping = JSON.parse(req.body.columnMapping);
      } catch {
        throw new AppError('columnMapping debe ser un JSON válido', 400);
      }
    }

    let defaults = {};
    if (req.body.defaults) {
      try {
        defaults = JSON.parse(req.body.defaults);
      } catch {
        throw new AppError('defaults debe ser un JSON válido', 400);
      }
    }

    const resultado = await importService.procesarImportacion(req.businessId, req.user._id, {
      file: req.file,
      columnMapping,
      defaults,
    });

    return respuestaExito(res, {
      statusCode: 201,
      message: `Importación completada: ${resultado.successCount} leads creados, ${resultado.duplicateCount} duplicados, ${resultado.errorCount} errores`,
      data: { importacion: resultado },
    });
  } catch (err) {
    next(err);
  }
};

const listImports = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const { imports, total } = await importService.listarImportaciones(req.businessId, { page, limit });
    return respuestaExito(res, {
      message: 'Importaciones obtenidas exitosamente',
      data: { imports },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
};

const getImport = async (req, res, next) => {
  try {
    const importRecord = await importService.obtenerImportacion(req.businessId, req.params.id);
    return respuestaExito(res, {
      message: 'Importación obtenida exitosamente',
      data: { importacion: importRecord },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { uploadImport, listImports, getImport };
