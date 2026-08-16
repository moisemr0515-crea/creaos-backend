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
    // req.user.business viene de una consulta fresca a la base en
    // authenticate() (User.findById en cada request) — se prioriza sobre
    // req.businessId, que viene embebido en el JWT y puede quedar
    // desactualizado (ej. tras cambiar el negocio de un usuario, como en
    // la fusión CREA OS/Myrel Company) hasta que el access token se
    // renueve. req.businessId queda como fallback solo para el caso raro
    // de que req.user no traiga business poblado.
    const businessId = req.user?.business?.toString() || req.businessId;

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
