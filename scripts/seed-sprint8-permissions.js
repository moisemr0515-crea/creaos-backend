require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const { ROLES, PERMISSIONS, ROLE_PERMISSIONS } = require('../src/config/constants');
const Role       = require('../src/modules/roles/role.model');
const Permission = require('../src/modules/roles/permission.model');
const logger     = require('../src/utils/logger');

const NUEVOS_PERMISOS = [
  { module: 'reports',       action: 'export', slug: PERMISSIONS.REPORTS_EXPORT,     description: 'Exportar reportes a CSV' },
  { module: 'admin',         action: 'read',   slug: PERMISSIONS.ADMIN_READ,          description: 'Ver panel de administración' },
  { module: 'admin',         action: 'write',  slug: PERMISSIONS.ADMIN_WRITE,         description: 'Editar desde panel de administración' },
  { module: 'notifications', action: 'read',   slug: PERMISSIONS.NOTIFICATIONS_READ,  description: 'Recibir y leer notificaciones' },
];

const seed = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  // ─── 1. Upsert nuevos permisos ────────────────────────────────────────────
  logger.info('\n━━━ Sincronizando permisos Sprint 8 ━━━');
  for (const p of NUEVOS_PERMISOS) {
    await Permission.findOneAndUpdate({ slug: p.slug }, p, { upsert: true, new: true });
    logger.info(`  ✓ ${p.slug}`);
  }

  // ─── 2. Actualizar todos los roles del sistema ────────────────────────────
  logger.info('\n━━━ Actualizando permisos de roles ━━━');

  const rolesActualizar = [
    { slug: ROLES.SUPER_ADMIN, name: 'Super Admin',  perms: Object.values(PERMISSIONS) },
    { slug: ROLES.OWNER,   name: 'Owner',    perms: ROLE_PERMISSIONS[ROLES.OWNER] },
    { slug: ROLES.ADMIN,   name: 'Admin',    perms: ROLE_PERMISSIONS[ROLES.ADMIN] },
    { slug: ROLES.MANAGER, name: 'Manager',  perms: ROLE_PERMISSIONS[ROLES.MANAGER] },
    { slug: ROLES.SALES,   name: 'Sales',    perms: ROLE_PERMISSIONS[ROLES.SALES] },
    { slug: ROLES.SUPPORT, name: 'Support',  perms: ROLE_PERMISSIONS[ROLES.SUPPORT] },
    { slug: ROLES.VIEWER,  name: 'Viewer',   perms: ROLE_PERMISSIONS[ROLES.VIEWER] },
  ];

  for (const r of rolesActualizar) {
    await Role.findOneAndUpdate(
      { slug: r.slug, business: null },
      { name: r.name, slug: r.slug, permissions: r.perms, isSystem: true, business: null },
      { upsert: true, new: true }
    );
    logger.info(`  ✓ ${r.name}: ${r.perms.length} permisos`);
  }

  logger.info('\n✅ Seed Sprint 8 completado\n');

  // ─── Resumen de la matriz de permisos ─────────────────────────────────────
  const sprint8Perms = [
    PERMISSIONS.ADMIN_READ,
    PERMISSIONS.ADMIN_WRITE,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.REPORTS_EXPORT,
    PERMISSIONS.NOTIFICATIONS_READ,
  ];

  logger.info('━━━ Matriz de permisos Sprint 8 ━━━');
  for (const r of rolesActualizar) {
    const tiene = sprint8Perms.filter((p) => r.perms.includes(p));
    logger.info(`  ${r.name.padEnd(12)}: ${tiene.join(', ') || '—'}`);
  }

  await mongoose.connection.close();
};

seed().catch((err) => {
  logger.error('❌ Error en seed Sprint 8:', err.message);
  process.exit(1);
});
