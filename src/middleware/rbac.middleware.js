const { AppError } = require('./error.middleware');
const { ROLES } = require('../config/constants');

/**
 * Factory que devuelve un middleware que verifica si el usuario tiene el permiso dado.
 *
 * Uso en rutas:
 *   router.get('/users', authenticate, checkPermission('users:read'), controller)
 *
 * @param {string} permiso - En formato "modulo:accion" (ej: 'users:read')
 */
const checkPermission = (permiso) => {
  return (req, res, next) => {
    try {
      const { user } = req;

      if (!user || !user.role) {
        throw new AppError('Usuario sin rol asignado', 403);
      }

      const roleSlug = user.role.slug;
      const permisos = user.role.permissions || [];

      // SuperAdmin siempre tiene acceso total
      if (roleSlug === ROLES.SUPER_ADMIN) {
        return next();
      }

      // Verificar si el rol tiene el permiso requerido
      if (!permisos.includes(permiso)) {
        throw new AppError(
          `No tienes permiso para realizar esta acción (${permiso})`,
          403
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Verifica que el usuario tenga al menos uno de los roles dados.
 *
 * Uso:
 *   router.delete('/users/:id', authenticate, checkRole('owner', 'admin'), controller)
 *
 * @param {...string} roles - Slugs de roles permitidos
 */
const checkRole = (...roles) => {
  return (req, res, next) => {
    try {
      const { user } = req;

      if (!user || !user.role) {
        throw new AppError('Usuario sin rol asignado', 403);
      }

      const roleSlug = user.role.slug;

      if (roleSlug === ROLES.SUPER_ADMIN || roles.includes(roleSlug)) {
        return next();
      }

      throw new AppError(
        `Acceso denegado. Roles permitidos: ${roles.join(', ')}`,
        403
      );
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { checkPermission, checkRole };
