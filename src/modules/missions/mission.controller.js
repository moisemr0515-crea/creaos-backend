const missionService = require('./mission.service');
const { respuestaExito } = require('../../utils/response');

/**
 * GET /api/v1/missions/today
 * Devuelve la Misión del Día cacheada, generándola si es el primer acceso del día.
 */
const getMisionDeHoy = async (req, res, next) => {
  try {
    const mision = await missionService.obtenerMisionDeHoy(req.businessId);
    return respuestaExito(res, { message: 'Misión del día obtenida exitosamente', data: { mision } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/missions/regenerate
 * Fuerza una regeneración nueva de la Misión del Día, sobrescribiendo el cache de hoy.
 */
const regenerarMision = async (req, res, next) => {
  try {
    const mision = await missionService.regenerarMisionDeHoy(req.businessId);
    return respuestaExito(res, { message: 'Misión del día regenerada exitosamente', data: { mision } });
  } catch (error) {
    next(error);
  }
};

module.exports = { getMisionDeHoy, regenerarMision };
