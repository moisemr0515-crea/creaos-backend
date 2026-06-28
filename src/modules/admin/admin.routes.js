const express = require('express');
const ctrl    = require('./admin.controller');
const { authenticate }               = require('../../middleware/auth.middleware');
const { checkRole, checkPermission } = require('../../middleware/rbac.middleware');
const { ROLES } = require('../../config/constants');

const router = express.Router();

router.use(authenticate);

// ─── SuperAdmin: acceso global ────────────────────────────────────────────────
router.get('/dashboard',                 checkRole(ROLES.SUPER_ADMIN), ctrl.getGlobalDashboard);
router.get('/revenue',                   checkRole(ROLES.SUPER_ADMIN), ctrl.getRevenue);
router.get('/businesses',                checkRole(ROLES.SUPER_ADMIN), ctrl.listBusinesses);
router.get('/businesses/:id',            checkRole(ROLES.SUPER_ADMIN), ctrl.getBusiness);
router.put('/businesses/:id',            checkRole(ROLES.SUPER_ADMIN), ctrl.updateBusiness);
router.patch('/businesses/:id/suspend',  checkRole(ROLES.SUPER_ADMIN), ctrl.suspendBusiness);
router.patch('/businesses/:id/activate', checkRole(ROLES.SUPER_ADMIN), ctrl.activateBusiness);
router.get('/users',                     checkRole(ROLES.SUPER_ADMIN), ctrl.listUsers);

// ─── Owner / Admin: su propio negocio ────────────────────────────────────────
// IMPORTANTE: rutas con segmento fijo antes de rutas con parámetros (:id, :userId)
router.get('/dashboard/:businessId',    checkPermission('admin:read'),  ctrl.getBusinessDashboard);
router.get('/activity/:businessId',     checkPermission('admin:read'),  ctrl.getActivityFeed);

router.get('/config',                   checkPermission('admin:read'),  ctrl.getBusinessConfig);
router.put('/config',                   checkPermission('admin:write'), ctrl.updateBusinessConfig);
router.get('/config/users',             checkPermission('admin:read'),  ctrl.getBusinessUsers);
router.post('/config/users/invite',     checkPermission('admin:write'), ctrl.inviteUser);
router.delete('/config/users/:userId',  checkPermission('admin:write'), ctrl.removeUser);

router.get('/users/:id',                checkPermission('admin:read'),  ctrl.getUser);
router.put('/users/:id',                checkPermission('admin:write'), ctrl.updateUser);
router.patch('/users/:id/role',         checkPermission('admin:write'), ctrl.changeUserRole);
router.patch('/users/:id/suspend',      checkPermission('admin:write'), ctrl.suspendUser);
router.patch('/users/:id/activate',     checkPermission('admin:write'), ctrl.activateUser);

// ─── Reportes: Owner/Admin de su negocio (SuperAdmin lo pasa por bypass) ─────
// IMPORTANTE: /export antes de /:param para evitar conflicto
router.get('/reports/leads/export',     checkPermission('reports:read'), ctrl.exportLeads);
router.get('/reports/leads',            checkPermission('reports:read'), ctrl.getLeadsReport);
router.get('/reports/conversions',      checkPermission('reports:read'), ctrl.getConversionsReport);
router.get('/reports/ai',               checkPermission('reports:read'), ctrl.getAIUsageReport);

// ─── Notificaciones: todos los autenticados ───────────────────────────────────
router.get('/notifications',              ctrl.getNotifications);
router.get('/notifications/unread-count', ctrl.getUnreadCount);
router.patch('/notifications/read-all',   ctrl.markAllNotificationsRead);
router.patch('/notifications/:id/read',   ctrl.markNotificationRead);
router.delete('/notifications/:id',       ctrl.deleteNotification);

module.exports = router;
