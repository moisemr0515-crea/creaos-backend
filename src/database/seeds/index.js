require('dotenv').config();

// Forzar Google DNS como primera instrucción (router bloquea consultas SRV)
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const { ejecutarSeed: seedRoles } = require('./roles.seed');
const logger = require('../../utils/logger');

/**
 * Seed principal: ejecuta todos los seeds en orden.
 * Uso: npm run seed
 */
const ejecutarTodos = async () => {
  logger.info('🌱 Iniciando seeds de CREA OS...\n');

  try {
    logger.info('━━━ PASO 1: Roles y Permisos ━━━');
    await seedRoles();
    logger.info('');

    logger.info('🎉 Todos los seeds completados exitosamente');
    logger.info('\nAhora puedes ejecutar: npm run dev\n');
  } catch (error) {
    logger.error('❌ Error ejecutando seeds:', error);
    process.exit(1);
  }
};

ejecutarTodos();
