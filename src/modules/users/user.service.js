const User = require('./user.model');
const Role = require('../roles/role.model');
const { AppError } = require('../../middleware/error.middleware');
const { hashPassword, comparePassword } = require('../../utils/crypto');
const { ROLES } = require('../../config/constants');

// ─── MI PERFIL ────────────────────────────────────────────────────────────────

/**
 * Devuelve el perfil completo del usuario autenticado.
 */
const obtenerMiPerfil = async (userId) => {
  const usuario = await User.findById(userId)
    .populate('role', 'slug name permissions')
    .populate('business', 'name slug logo plan planStatus onboardingCompleted');

  if (!usuario) throw new AppError('Usuario no encontrado', 404);

  return usuario;
};

/**
 * Actualiza datos de perfil (nombre, teléfono, avatar).
 */
const actualizarMiPerfil = async (userId, { name, phone, avatar }) => {
  const datos = {};
  if (name !== undefined) datos.name = name;
  if (phone !== undefined) datos.phone = phone;
  if (avatar !== undefined) datos.avatar = avatar;

  const usuario = await User.findByIdAndUpdate(userId, datos, {
    new: true,
    runValidators: true,
  }).populate('role', 'slug name');

  if (!usuario) throw new AppError('Usuario no encontrado', 404);

  return usuario;
};

/**
 * Cambia la contraseña del usuario autenticado.
 */
const cambiarPassword = async (userId, { currentPassword, newPassword }) => {
  const usuario = await User.findById(userId).select('+password');
  if (!usuario) throw new AppError('Usuario no encontrado', 404);

  const passwordCorrecta = await comparePassword(currentPassword, usuario.password);
  if (!passwordCorrecta) {
    throw new AppError('La contraseña actual es incorrecta', 400);
  }

  if (currentPassword === newPassword) {
    throw new AppError('La nueva contraseña debe ser diferente a la actual', 400);
  }

  const passwordHash = await hashPassword(newPassword);
  await User.findByIdAndUpdate(userId, { password: passwordHash });
};

// ─── GESTIÓN DE USUARIOS (Admin+) ─────────────────────────────────────────────

/**
 * Lista usuarios activos del negocio con paginación.
 */
const listarUsuarios = async (businessId, { page = 1, limit = 20, search = '' }) => {
  const skip = (page - 1) * limit;
  const filtro = { business: businessId, isActive: true };

  if (search) {
    filtro.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  const [usuarios, total] = await Promise.all([
    User.find(filtro)
      .populate('role', 'slug name')
      .select('-refreshTokenJtis')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10)),
    User.countDocuments(filtro),
  ]);

  return { usuarios, total };
};

/**
 * Actualiza datos de un usuario del mismo negocio (Admin+).
 */
const actualizarUsuario = async (userId, businessId, actualizadorRole, { name, phone, roleId, isActive }) => {
  const usuario = await User.findOne({ _id: userId, business: businessId })
    .populate('role', 'slug');

  if (!usuario) throw new AppError('Usuario no encontrado en este negocio', 404);

  // No puede modificar a alguien de rol superior
  if (usuario.role.slug === ROLES.OWNER && actualizadorRole !== ROLES.SUPER_ADMIN) {
    throw new AppError('No puedes modificar al Owner del negocio', 403);
  }

  const datos = {};
  if (name !== undefined) datos.name = name;
  if (phone !== undefined) datos.phone = phone;
  if (isActive !== undefined) datos.isActive = isActive;

  // Cambio de rol: verificar que el nuevo rol pertenece al mismo negocio o es del sistema
  if (roleId !== undefined) {
    const nuevoRol = await Role.findOne({
      _id: roleId,
      $or: [{ business: businessId }, { business: null }],
    });
    if (!nuevoRol) throw new AppError('Rol no válido para este negocio', 400);

    // No puede asignar rol Owner
    if (nuevoRol.slug === ROLES.OWNER) {
      throw new AppError('No puedes asignar el rol Owner directamente', 403);
    }

    datos.role = roleId;
  }

  const usuarioActualizado = await User.findByIdAndUpdate(userId, datos, {
    new: true,
    runValidators: true,
  }).populate('role', 'slug name');

  return usuarioActualizado;
};

/**
 * Desactiva (soft delete) un usuario del negocio (solo Owner).
 */
const desactivarUsuario = async (userId, businessId, solicitanteId) => {
  if (userId === solicitanteId) {
    throw new AppError('No puedes desactivar tu propia cuenta', 400);
  }

  const usuario = await User.findOne({ _id: userId, business: businessId })
    .populate('role', 'slug');

  if (!usuario) throw new AppError('Usuario no encontrado en este negocio', 404);

  if (usuario.role.slug === ROLES.OWNER) {
    throw new AppError('No puedes desactivar al Owner del negocio', 403);
  }

  await User.findByIdAndUpdate(userId, { isActive: false });
};

module.exports = {
  obtenerMiPerfil,
  actualizarMiPerfil,
  cambiarPassword,
  listarUsuarios,
  actualizarUsuario,
  desactivarUsuario,
};
