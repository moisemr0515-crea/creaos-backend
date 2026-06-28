const { AppError } = require('./error.middleware');
const Business = require('../modules/businesses/business.model');

/**
 * Inyecta el businessId en el request y valida que el negocio exista y esté activo.
 * Debe ejecutarse DESPUÉS de authenticate.
 *
 * Garantiza aislamiento multi-tenant: todas las queries subsecuentes
 * filtran por req.businessId.
 */
const injectTenant = async (req, res, next) => {
  try {
    const businessId = req.businessId || req.user?.business?.toString();

    if (!businessId) {
      throw new AppError('No se pudo determinar el negocio del usuario', 400);
    }

    // Validar que el negocio exista y esté activo
    const negocio = await Business.findOne({ _id: businessId, isActive: true }).select('_id name plan planStatus');

    if (!negocio) {
      throw new AppError('Negocio no encontrado o inactivo', 403);
    }

    // Disponible en todos los handlers siguientes
    req.businessId = businessId;
    req.business = negocio;

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { injectTenant };
