const Role = require('./role.model');
const { ROLE_PERMISSIONS } = require('../../config/constants');
const { AppError } = require('../../middleware/error.middleware');

/**
 * Verifica en tiempo real si un rol tiene un permiso específico,
 * consultando la BD en lugar de depender solo del JWT.
 * Más seguro para cambios de roles en tiempo real.
 *
 * Uso en rutas críticas donde se requiere verificación fresca:
 *   router.get('/admin', authenticate, verificarPermisoFresco('users:delete'), controller)
 */
const verificarPermisoFresco = (permiso) => {
  return async (req, res, next) => {
    try {
      const roleId = req.user?.role?._id;
      if (!roleId) throw new AppError('Sin rol asignado', 403);

      const rol = await Role.findById(roleId).select('slug permissions');
      if (!rol) throw new AppError('Rol no encontrado', 403);

      if (!rol.permissions.includes(permiso)) {
        throw new AppError(`Permiso requerido: ${permiso}`, 403);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Sincroniza los permisos del rol con los definidos en constants.js.
 * Útil al hacer seedin o actualización de permisos del sistema.
 */
const sincronizarPermisosRol = async (roleSlug) => {
  const permisos = ROLE_PERMISSIONS[roleSlug];
  if (!permisos) throw new Error(`Slug de rol no reconocido: ${roleSlug}`);

  await Role.findOneAndUpdate(
    { slug: roleSlug, business: null },
    { $set: { permissions: permisos } },
    { new: true }
  );
};

module.exports = { verificarPermisoFresco, sincronizarPermisosRol };
