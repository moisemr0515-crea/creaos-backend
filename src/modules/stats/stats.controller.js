const statsService = require('./stats.service');
const { summaryQuerySchema } = require('./stats.validator');
const { validateQuery } = require('../../shared/utils/validate');
const { respuestaExito } = require('../../utils/response');

/**
 * GET /api/v1/stats/summary?period=this_month|last_month|custom&from=AAAA-MM-DD&to=AAAA-MM-DD
 * Cifras de Estadísticas del negocio del token (nunca de otro) calculadas en el servidor.
 */
const getSummary = async (req, res, next) => {
  try {
    const query = await validateQuery(summaryQuerySchema, req.query);
    const resumen = await statsService.obtenerResumen(req.businessId, query);
    return respuestaExito(res, { message: 'Estadísticas obtenidas exitosamente', data: { resumen } });
  } catch (error) {
    next(error);
  }
};

module.exports = { getSummary };
