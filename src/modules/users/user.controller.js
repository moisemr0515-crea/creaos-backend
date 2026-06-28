const userService = require('./user.service');
const { respuestaExito, buildMeta } = require('../../utils/response');

/**
 * GET /api/v1/users/me
 * Devuelve el perfil del usuario autenticado.
 */
const getMiPerfil = async (req, res, next) => {
  try {
    const usuario = await userService.obtenerMiPerfil(req.user._id);

    return respuestaExito(res, {
      message: 'Perfil obtenido exitosamente',
      data: { usuario },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/users/me
 * Actualiza nombre, teléfono o avatar del usuario autenticado.
 */
const updateMiPerfil = async (req, res, next) => {
  try {
    const { name, phone, avatar } = req.body;
    const usuario = await userService.actualizarMiPerfil(req.user._id, { name, phone, avatar });

    return respuestaExito(res, {
      message: 'Perfil actualizado exitosamente',
      data: { usuario },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/users/security
 * Cambia la contraseña del usuario autenticado.
 */
const updateSecurity = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await userService.cambiarPassword(req.user._id, { currentPassword, newPassword });

    return respuestaExito(res, {
      message: 'Contraseña actualizada exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/users
 * Lista usuarios del negocio (Admin+).
 */
const getUsuarios = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const { usuarios, total } = await userService.listarUsuarios(req.businessId, {
      page,
      limit,
      search,
    });

    return respuestaExito(res, {
      message: 'Usuarios obtenidos exitosamente',
      data: { usuarios },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/users/:id
 * Edita un usuario del negocio (Admin+).
 */
const updateUsuario = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, roleId, isActive } = req.body;

    const usuario = await userService.actualizarUsuario(
      id,
      req.businessId,
      req.user.role.slug,
      { name, phone, roleId, isActive }
    );

    return respuestaExito(res, {
      message: 'Usuario actualizado exitosamente',
      data: { usuario },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/users/:id
 * Desactiva un usuario del negocio (solo Owner).
 */
const deleteUsuario = async (req, res, next) => {
  try {
    const { id } = req.params;
    await userService.desactivarUsuario(id, req.businessId, req.user._id.toString());

    return respuestaExito(res, {
      message: 'Usuario desactivado exitosamente',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getMiPerfil, updateMiPerfil, updateSecurity, getUsuarios, updateUsuario, deleteUsuario };
