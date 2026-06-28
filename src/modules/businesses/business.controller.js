const businessService = require('./business.service');
const { respuestaExito } = require('../../utils/response');

/**
 * GET /api/v1/businesses/current
 * Devuelve el negocio del usuario autenticado.
 */
const getNegocioActual = async (req, res, next) => {
  try {
    const negocio = await businessService.obtenerNegocioActual(req.businessId);

    return respuestaExito(res, {
      message: 'Negocio obtenido exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/businesses/current
 * Actualiza datos del negocio.
 */
const updateNegocioActual = async (req, res, next) => {
  try {
    const negocio = await businessService.actualizarNegocio(req.businessId, req.body);

    return respuestaExito(res, {
      message: 'Negocio actualizado exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/businesses/settings
 * Actualiza configuración avanzada del negocio.
 */
const updateSettings = async (req, res, next) => {
  try {
    const { timezone, language, notifications } = req.body;
    const settings = await businessService.actualizarSettings(req.businessId, {
      timezone,
      language,
      notifications,
    });

    return respuestaExito(res, {
      message: 'Configuración actualizada exitosamente',
      data: { settings },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getNegocioActual, updateNegocioActual, updateSettings };
