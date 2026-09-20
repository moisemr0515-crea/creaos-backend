const businessService = require('./business.service');
const businessAssetAccess = require('./businessAssetAccess.service');
const { respuestaExito } = require('../../utils/response');
const { AppError } = require('../../middleware/error.middleware');

const CAMPOS_ASSET_VALIDOS = ['logo', 'pdf', 'presentationVideo', 'brochure', 'photos'];

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

/**
 * POST /api/v1/businesses/current/presentation-video
 * Sube el video de presentación del negocio, para reenviarlo por WhatsApp
 * (send_media) — no se procesa ni se lee, es un archivo para reenvío.
 */
const uploadPresentationVideo = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Se requiere un archivo de video', 400);

    const negocio = await businessService.subirVideoPresentacion(req.businessId, req.file);

    return respuestaExito(res, {
      message: 'Video de presentación actualizado exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/businesses/current/brochure
 * Sube el brochure/folleto del negocio, para reenviarlo por WhatsApp
 * (send_media) — distinto del PDF informativo (/current/pdf), que
 * alimenta el conocimiento del agente.
 */
const uploadBrochure = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Se requiere un archivo PDF', 400);

    const negocio = await businessService.subirBrochure(req.businessId, req.file);

    return respuestaExito(res, {
      message: 'Brochure actualizado exitosamente',
      data: { negocio },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/businesses/current/assets/:campo/access
 * P0 de seguridad (auditoría Business Brain, 19/sep/2026, Bloque 1) — en
 * vez de que el frontend/IA lean la URL pública permanente guardada en el
 * negocio, este endpoint genera un acceso firmado y con expiración real
 * (businessAssetAccess.service.js), validando ownership vía
 * req.businessId (nunca un businessId que mande el cliente — injectTenant
 * ya lo resuelve server-side). `campo=photos` requiere `?index=N`.
 * `proposito` default 'display' (TTL corto) — 'send' (TTL largo) es solo
 * para el envío por WhatsApp (ai/tools/index.js#sendMedia()), invocado
 * directo como función, nunca vía este endpoint HTTP.
 */
const getAssetAccess = async (req, res, next) => {
  try {
    const { campo } = req.params;
    if (!CAMPOS_ASSET_VALIDOS.includes(campo)) {
      throw new AppError(`Campo de asset inválido: "${campo}"`, 400);
    }

    const negocio = await businessService.obtenerNegocioActual(req.businessId);

    const url = campo === 'photos'
      ? businessAssetAccess.obtenerUrlDeAccesoFoto(negocio, Number(req.query.index) || 0, 'display')
      : businessAssetAccess.obtenerUrlDeAcceso(negocio, campo, 'display');

    if (!url) throw new AppError('Este negocio todavía no cargó ese archivo', 404);

    return respuestaExito(res, { message: 'Acceso generado', data: { url } });
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
  uploadPresentationVideo,
  uploadBrochure,
  getAssetAccess,
};
