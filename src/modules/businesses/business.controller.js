const businessService = require('./business.service');
const { respuestaExito } = require('../../utils/response');
const { AppError } = require('../../middleware/error.middleware');

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

/**
 * POST /api/v1/businesses/current/logo
 * Sube el logo del negocio a Cloudinary.
 */
const uploadLogo = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Se requiere un archivo de imagen', 400);

    const negocio = await businessService.subirLogo(req.businessId, req.file);

    return respuestaExito(res, {
      message: 'Logo actualizado exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/businesses/current/photos
 * Sube hasta 2 fotos de producto a Cloudinary.
 */
const uploadPhotos = async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw new AppError('Se requiere al menos 1 imagen', 400);
    }

    const negocio = await businessService.subirFotos(req.businessId, req.files);

    return respuestaExito(res, {
      message: 'Fotos actualizadas exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/businesses/current/pdf
 * Sube el PDF informativo y extrae su texto para la IA de ventas.
 */
const uploadPdf = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Se requiere un archivo PDF', 400);

    const negocio = await businessService.subirPdf(req.businessId, req.file);

    return respuestaExito(res, {
      message: 'PDF procesado exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getNegocioActual,
  updateNegocioActual,
  updateSettings,
  uploadLogo,
  uploadPhotos,
  uploadPdf,
};
