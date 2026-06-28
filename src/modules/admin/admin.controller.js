const mongoose = require('mongoose');
const dashboardService    = require('./dashboard.service');
const reportsService      = require('./reports.service');
const notificationService = require('./notification.service');
const Business = require('../businesses/business.model');
const User     = require('../users/user.model');
const Role     = require('../roles/role.model');
const { AppError }    = require('../../middleware/error.middleware');
const { respuestaExito, buildMeta } = require('../../utils/response');
const { hashPassword, generateToken } = require('../../utils/crypto');
const { enviarEmailVerificacion }     = require('../../utils/email');
const { ROLES } = require('../../config/constants');

// ─── Dashboard ────────────────────────────────────────────────────────────────

const getGlobalDashboard = async (req, res, next) => {
  try {
    const stats = await dashboardService.getGlobalStats();
    respuestaExito(res, { message: 'Estadísticas globales', data: stats });
  } catch (err) { next(err); }
};

const getBusinessDashboard = async (req, res, next) => {
  try {
    const businessId = req.params.businessId || req.params.id || req.businessId;
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new AppError('ID inválido', 400);
    const stats = await dashboardService.getBusinessStats(businessId);
    respuestaExito(res, { message: 'Estadísticas del negocio', data: stats });
  } catch (err) { next(err); }
};

const getRevenue = async (req, res, next) => {
  try {
    const stats = await dashboardService.getRevenueStats();
    respuestaExito(res, { message: 'Estadísticas de ingresos', data: stats });
  } catch (err) { next(err); }
};

const getActivityFeed = async (req, res, next) => {
  try {
    const businessId = req.params.businessId || req.businessId;
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new AppError('ID inválido', 400);
    const limit    = parseInt(req.query.limit, 10) || 20;
    const feed     = await dashboardService.getActivityFeed(businessId, limit);
    respuestaExito(res, { message: 'Feed de actividad', data: feed });
  } catch (err) { next(err); }
};

// ─── Businesses (SuperAdmin) ──────────────────────────────────────────────────

const listBusinesses = async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page, 10)  || 1;
    const limit  = parseInt(req.query.limit, 10) || 20;
    const skip   = (page - 1) * limit;
    const search = req.query.search?.trim();

    const filter = {};
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const [businesses, total] = await Promise.all([
      Business.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Business.countDocuments(filter),
    ]);

    respuestaExito(res, {
      message: 'Lista de negocios',
      data:    businesses,
      meta:    buildMeta({ page, limit, total }),
    });
  } catch (err) { next(err); }
};

const getBusiness = async (req, res, next) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    respuestaExito(res, { message: 'Negocio', data: business });
  } catch (err) { next(err); }
};

const updateBusiness = async (req, res, next) => {
  try {
    const allowed = ['name', 'industry', 'country', 'currency', 'phone', 'email', 'website', 'logo'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const business = await Business.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!business) throw new AppError('Negocio no encontrado', 404);
    respuestaExito(res, { message: 'Negocio actualizado', data: business });
  } catch (err) { next(err); }
};

const suspendBusiness = async (req, res, next) => {
  try {
    const business = await Business.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!business) throw new AppError('Negocio no encontrado', 404);
    respuestaExito(res, { message: 'Negocio suspendido', data: { id: business._id, isActive: false } });
  } catch (err) { next(err); }
};

const activateBusiness = async (req, res, next) => {
  try {
    const business = await Business.findByIdAndUpdate(req.params.id, { isActive: true }, { new: true });
    if (!business) throw new AppError('Negocio no encontrado', 404);
    respuestaExito(res, { message: 'Negocio activado', data: { id: business._id, isActive: true } });
  } catch (err) { next(err); }
};

// ─── Users (SuperAdmin) ───────────────────────────────────────────────────────

const listUsers = async (req, res, next) => {
  try {
    const page    = parseInt(req.query.page, 10)  || 1;
    const limit   = parseInt(req.query.limit, 10) || 20;
    const skip    = (page - 1) * limit;
    const search  = req.query.search?.trim();
    const roleSlug = req.user.role.slug;

    const filter = {};

    if (roleSlug !== ROLES.SUPER_ADMIN) {
      filter.business = req.businessId;
    } else if (req.query.businessId) {
      filter.business = req.query.businessId;
    }

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const [users, total] = await Promise.all([
      User.find(filter)
        .populate('role', 'slug')
        .populate('business', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-password -refreshTokenJtis'),
      User.countDocuments(filter),
    ]);

    respuestaExito(res, {
      message: 'Lista de usuarios',
      data:    users,
      meta:    buildMeta({ page, limit, total }),
    });
  } catch (err) { next(err); }
};

const getUser = async (req, res, next) => {
  try {
    const callerRole = req.user.role.slug;
    const target = await User.findById(req.params.id)
      .populate('role', 'slug permissions')
      .populate('business', 'name slug')
      .select('-password -refreshTokenJtis');
    if (!target) throw new AppError('Usuario no encontrado', 404);

    if (callerRole !== ROLES.SUPER_ADMIN && target.business._id.toString() !== req.businessId.toString()) {
      throw new AppError('Sin acceso a este usuario', 403);
    }

    respuestaExito(res, { message: 'Usuario', data: target });
  } catch (err) { next(err); }
};

const updateUser = async (req, res, next) => {
  try {
    const callerRole = req.user.role.slug;
    const target     = await User.findById(req.params.id);
    if (!target) throw new AppError('Usuario no encontrado', 404);

    if (callerRole !== ROLES.SUPER_ADMIN && target.business.toString() !== req.businessId.toString()) {
      throw new AppError('Sin acceso a este usuario', 403);
    }

    const allowed = ['name', 'phone', 'avatar'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const updated = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
      .populate('role', 'slug')
      .select('-password -refreshTokenJtis');

    respuestaExito(res, { message: 'Usuario actualizado', data: updated });
  } catch (err) { next(err); }
};

const changeUserRole = async (req, res, next) => {
  try {
    const { roleSlug } = req.body;
    if (!roleSlug) throw new AppError('roleSlug es requerido', 400);

    const callerRole = req.user.role.slug;

    if (callerRole !== ROLES.SUPER_ADMIN) {
      const forbidden = [ROLES.SUPER_ADMIN, ROLES.OWNER];
      if (forbidden.includes(roleSlug)) {
        throw new AppError('No puedes asignar ese rol', 403);
      }
    }

    const role = await Role.findOne({ slug: roleSlug });
    if (!role) throw new AppError('Rol no encontrado', 404);

    const target = await User.findById(req.params.id);
    if (!target) throw new AppError('Usuario no encontrado', 404);

    if (callerRole !== ROLES.SUPER_ADMIN && target.business.toString() !== req.businessId.toString()) {
      throw new AppError('Sin acceso a este usuario', 403);
    }

    target.role = role._id;
    await target.save();

    respuestaExito(res, { message: 'Rol actualizado', data: { userId: target._id, newRole: roleSlug } });
  } catch (err) { next(err); }
};

const suspendUser = async (req, res, next) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) throw new AppError('Usuario no encontrado', 404);

    const callerRole = req.user.role.slug;
    if (callerRole !== ROLES.SUPER_ADMIN && target.business.toString() !== req.businessId.toString()) {
      throw new AppError('Sin acceso a este usuario', 403);
    }
    if (target._id.toString() === req.user._id.toString()) {
      throw new AppError('No puedes suspenderte a ti mismo', 400);
    }

    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    respuestaExito(res, { message: 'Usuario suspendido', data: { userId: target._id, isActive: false } });
  } catch (err) { next(err); }
};

const activateUser = async (req, res, next) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) throw new AppError('Usuario no encontrado', 404);

    const callerRole = req.user.role.slug;
    if (callerRole !== ROLES.SUPER_ADMIN && target.business.toString() !== req.businessId.toString()) {
      throw new AppError('Sin acceso a este usuario', 403);
    }

    await User.findByIdAndUpdate(req.params.id, { isActive: true });
    respuestaExito(res, { message: 'Usuario activado', data: { userId: target._id, isActive: true } });
  } catch (err) { next(err); }
};

// ─── Business Config (Owner / Admin) ─────────────────────────────────────────

const getBusinessConfig = async (req, res, next) => {
  try {
    const business = await Business.findById(req.businessId);
    if (!business) throw new AppError('Negocio no encontrado', 404);
    respuestaExito(res, { message: 'Configuración del negocio', data: business });
  } catch (err) { next(err); }
};

const updateBusinessConfig = async (req, res, next) => {
  try {
    const allowed = ['name', 'logo', 'industry', 'country', 'currency', 'phone', 'email', 'website', 'settings'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const business = await Business.findByIdAndUpdate(req.businessId, updates, { new: true, runValidators: true });
    if (!business) throw new AppError('Negocio no encontrado', 404);
    respuestaExito(res, { message: 'Configuración actualizada', data: business });
  } catch (err) { next(err); }
};

// ─── Business Users (Owner / Admin) ──────────────────────────────────────────

const getBusinessUsers = async (req, res, next) => {
  try {
    const users = await User.find({ business: req.businessId })
      .populate('role', 'slug')
      .sort({ createdAt: -1 })
      .select('-password -refreshTokenJtis');
    respuestaExito(res, { message: 'Usuarios del negocio', data: users });
  } catch (err) { next(err); }
};

const inviteUser = async (req, res, next) => {
  try {
    const { name, email, roleSlug = 'sales' } = req.body;
    if (!name || !email) throw new AppError('name y email son requeridos', 400);

    const existing = await User.findOne({ email });
    if (existing) throw new AppError('El email ya está registrado', 409);

    const role = await Role.findOne({ slug: roleSlug });
    if (!role) throw new AppError('Rol no encontrado', 404);

    const forbidden = [ROLES.SUPER_ADMIN, ROLES.OWNER];
    if (forbidden.includes(roleSlug) && req.user.role.slug !== ROLES.SUPER_ADMIN) {
      throw new AppError('No puedes invitar con ese rol', 403);
    }

    const tempPassword = Math.random().toString(36).slice(-10) + 'A1!';
    const passwordHash = await hashPassword(tempPassword);
    const { tokenPlano, tokenHash } = generateToken();
    const expiracion = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const user = await User.create({
      name,
      email,
      password:                  passwordHash,
      role:                      role._id,
      business:                  req.businessId,
      isEmailVerified:           false,
      emailVerificationToken:    tokenHash,
      emailVerificationExpires:  expiracion,
    });

    await enviarEmailVerificacion({ email, nombre: name, token: tokenPlano }).catch(() => {});

    respuestaExito(res, {
      statusCode: 201,
      message:    'Invitación enviada',
      data:       { userId: user._id, email, name, role: roleSlug },
    });
  } catch (err) { next(err); }
};

const removeUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) throw new AppError('ID inválido', 400);

    const target = await User.findOne({ _id: userId, business: req.businessId });
    if (!target) throw new AppError('Usuario no encontrado en este negocio', 404);

    if (target._id.toString() === req.user._id.toString()) {
      throw new AppError('No puedes eliminarte a ti mismo', 400);
    }

    await User.findByIdAndDelete(userId);
    respuestaExito(res, { message: 'Usuario eliminado del negocio', data: { userId } });
  } catch (err) { next(err); }
};

// ─── Reportes ─────────────────────────────────────────────────────────────────

const getLeadsReport = async (req, res, next) => {
  try {
    const businessId = req.user.role.slug === ROLES.SUPER_ADMIN && req.query.businessId
      ? req.query.businessId
      : req.businessId;
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new AppError('ID inválido', 400);

    const { startDate, endDate, source, stage, page, limit } = req.query;
    const report = await reportsService.getLeadsReport(businessId, { startDate, endDate, source, stage, page, limit });
    respuestaExito(res, { message: 'Reporte de leads', data: report });
  } catch (err) { next(err); }
};

const getConversionsReport = async (req, res, next) => {
  try {
    const businessId = req.user.role.slug === ROLES.SUPER_ADMIN && req.query.businessId
      ? req.query.businessId
      : req.businessId;
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new AppError('ID inválido', 400);

    const { startDate, endDate } = req.query;
    const report = await reportsService.getConversionsReport(businessId, { startDate, endDate });
    respuestaExito(res, { message: 'Reporte de conversiones', data: report });
  } catch (err) { next(err); }
};

const getAIUsageReport = async (req, res, next) => {
  try {
    const businessId = req.user.role.slug === ROLES.SUPER_ADMIN && req.query.businessId
      ? req.query.businessId
      : req.businessId;
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new AppError('ID inválido', 400);

    const { startDate, endDate } = req.query;
    const report = await reportsService.getAIUsageReport(businessId, { startDate, endDate });
    respuestaExito(res, { message: 'Reporte de uso IA', data: report });
  } catch (err) { next(err); }
};

const exportLeads = async (req, res, next) => {
  try {
    const businessId = req.user.role.slug === ROLES.SUPER_ADMIN && req.query.businessId
      ? req.query.businessId
      : req.businessId;
    if (!mongoose.Types.ObjectId.isValid(businessId)) throw new AppError('ID inválido', 400);

    const { startDate, endDate, source, stage } = req.query;
    const csv = await reportsService.exportLeadsCSV(businessId, { startDate, endDate, source, stage });

    const filename = `leads_${businessId}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + csv); // BOM para Excel
  } catch (err) { next(err); }
};

// ─── Notifications ────────────────────────────────────────────────────────────

const getNotifications = async (req, res, next) => {
  try {
    const { page, limit, unreadOnly } = req.query;
    const result = await notificationService.getNotifications(
      req.user._id, req.businessId,
      { page, limit, unreadOnly: unreadOnly === 'true' }
    );
    respuestaExito(res, {
      message: 'Notificaciones',
      data:    result.items,
      meta:    buildMeta({ page: result.page, limit: result.limit, total: result.total }),
    });
  } catch (err) { next(err); }
};

const markNotificationRead = async (req, res, next) => {
  try {
    const notif = await notificationService.markAsRead(req.params.id, req.user._id, req.businessId);
    respuestaExito(res, { message: 'Marcada como leída', data: notif });
  } catch (err) { next(err); }
};

const markAllNotificationsRead = async (req, res, next) => {
  try {
    const result = await notificationService.markAllAsRead(req.user._id, req.businessId);
    respuestaExito(res, { message: 'Todas marcadas como leídas', data: result });
  } catch (err) { next(err); }
};

const getUnreadCount = async (req, res, next) => {
  try {
    const count = await notificationService.getUnreadCount(req.user._id, req.businessId);
    respuestaExito(res, { message: 'Contador de no leídas', data: { count } });
  } catch (err) { next(err); }
};

const deleteNotification = async (req, res, next) => {
  try {
    await notificationService.deleteNotification(req.params.id, req.user._id, req.businessId);
    respuestaExito(res, { message: 'Notificación eliminada' });
  } catch (err) { next(err); }
};

module.exports = {
  // Dashboard
  getGlobalDashboard,
  getBusinessDashboard,
  getRevenue,
  getActivityFeed,
  // Businesses
  listBusinesses,
  getBusiness,
  updateBusiness,
  suspendBusiness,
  activateBusiness,
  // Users
  listUsers,
  getUser,
  updateUser,
  changeUserRole,
  suspendUser,
  activateUser,
  // Reports
  getLeadsReport,
  getConversionsReport,
  getAIUsageReport,
  exportLeads,
  // Config
  getBusinessConfig,
  updateBusinessConfig,
  getBusinessUsers,
  inviteUser,
  removeUser,
  // Notifications
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
  deleteNotification,
};
