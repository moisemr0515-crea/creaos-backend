require('dotenv').config();

// Forzar Google DNS antes de cualquier conexión (el router bloquea consultas SRV)
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../../config/env');
const { ROLES, ROLE_PERMISSIONS, PERMISSIONS } = require('../../config/constants');
const Role = require('../../modules/roles/role.model');
const Permission = require('../../modules/roles/permission.model');
const logger = require('../../utils/logger');

/**
 * Definición de todos los permisos del sistema.
 */
const PERMISOS_SISTEMA = [
  { module: 'users', action: 'read', slug: PERMISSIONS.USERS_READ, description: 'Ver lista de usuarios' },
  { module: 'users', action: 'create', slug: PERMISSIONS.USERS_CREATE, description: 'Crear usuarios' },
  { module: 'users', action: 'update', slug: PERMISSIONS.USERS_UPDATE, description: 'Editar usuarios' },
  { module: 'users', action: 'delete', slug: PERMISSIONS.USERS_DELETE, description: 'Desactivar usuarios' },
  { module: 'businesses', action: 'read', slug: PERMISSIONS.BUSINESSES_READ, description: 'Ver datos del negocio' },
  { module: 'businesses', action: 'update', slug: PERMISSIONS.BUSINESSES_UPDATE, description: 'Editar datos del negocio' },
  { module: 'businesses', action: 'settings', slug: PERMISSIONS.BUSINESSES_SETTINGS, description: 'Editar configuración avanzada' },
  { module: 'leads', action: 'read', slug: PERMISSIONS.LEADS_READ, description: 'Ver leads' },
  { module: 'leads', action: 'create', slug: PERMISSIONS.LEADS_CREATE, description: 'Crear leads' },
  { module: 'leads', action: 'update', slug: PERMISSIONS.LEADS_UPDATE, description: 'Editar leads' },
  { module: 'leads', action: 'delete', slug: PERMISSIONS.LEADS_DELETE, description: 'Eliminar leads' },
  { module: 'leads', action: 'own', slug: PERMISSIONS.LEADS_OWN, description: 'Gestionar solo sus leads' },
  { module: 'pipeline', action: 'read', slug: PERMISSIONS.PIPELINE_READ, description: 'Ver pipeline' },
  { module: 'pipeline', action: 'update', slug: PERMISSIONS.PIPELINE_UPDATE, description: 'Mover leads en pipeline' },
  { module: 'messages', action: 'read', slug: PERMISSIONS.MESSAGES_READ, description: 'Leer mensajes' },
  { module: 'messages', action: 'create', slug: PERMISSIONS.MESSAGES_CREATE, description: 'Enviar mensajes' },
  { module: 'settings', action: 'read', slug: PERMISSIONS.SETTINGS_READ, description: 'Ver configuración' },
  { module: 'settings', action: 'update', slug: PERMISSIONS.SETTINGS_UPDATE, description: 'Editar configuración' },
  { module: 'reports', action: 'read', slug: PERMISSIONS.REPORTS_READ, description: 'Ver reportes' },
  { module: 'roles', action: 'read', slug: PERMISSIONS.ROLES_READ, description: 'Ver roles' },
  { module: 'roles', action: 'manage', slug: PERMISSIONS.ROLES_MANAGE, description: 'Gestionar roles y permisos' },
];

/**
 * Definición de los roles del sistema.
 */
const ROLES_SISTEMA = [
  { name: 'Super Admin', slug: ROLES.SUPER_ADMIN },
  { name: 'Owner', slug: ROLES.OWNER },
  { name: 'Admin', slug: ROLES.ADMIN },
  { name: 'Manager', slug: ROLES.MANAGER },
  { name: 'Sales', slug: ROLES.SALES },
  { name: 'Support', slug: ROLES.SUPPORT },
  { name: 'Viewer', slug: ROLES.VIEWER },
];

const ejecutarSeed = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ Conectado a MongoDB para seed');

  // ─── 1. Crear permisos ────────────────────────────────────────────────────
  logger.info('Sincronizando permisos del sistema...');

  for (const permiso of PERMISOS_SISTEMA) {
    await Permission.findOneAndUpdate(
      { slug: permiso.slug },
      permiso,
      { upsert: true, new: true }
    );
  }

  logger.info(`✅ ${PERMISOS_SISTEMA.length} permisos sincronizados`);

  // ─── 2. Crear/actualizar roles del sistema ────────────────────────────────
  logger.info('Sincronizando roles del sistema...');

  for (const rolDef of ROLES_SISTEMA) {
    const permisos = ROLE_PERMISSIONS[rolDef.slug] || [];

    await Role.findOneAndUpdate(
      { slug: rolDef.slug, business: null },
      {
        name: rolDef.name,
        slug: rolDef.slug,
        permissions: permisos,
        isSystem: true,
        business: null,
      },
      { upsert: true, new: true }
    );

    logger.info(`  → Rol '${rolDef.name}': ${permisos.length} permisos`);
  }

  logger.info(`✅ ${ROLES_SISTEMA.length} roles del sistema sincronizados`);

  await mongoose.connection.close();
  logger.info('✅ Seed completado exitosamente');
};

// Ejecutar si se llama directamente
if (require.main === module) {
  ejecutarSeed().catch((err) => {
    logger.error('❌ Error en seed:', err);
    process.exit(1);
  });
}

module.exports = { ejecutarSeed };
