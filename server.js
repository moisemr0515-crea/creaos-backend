// Cargar variables de entorno primero
require('dotenv').config();

// Forzar Google DNS (el router bloquea consultas SRV que usa mongodb+srv://)
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const { validateEnv, PORT } = require('./src/config/env');

// Validar variables críticas antes de arrancar
validateEnv();

const logger = require('./src/utils/logger');
const app = require('./src/app');
const { connectMongoDB } = require('./src/config/database');
const { connectRedis } = require('./src/config/redis');

let servidor;

const iniciar = async () => {
  try {
    // Conectar bases de datos en paralelo
    await Promise.all([connectMongoDB(), connectRedis()]);

    // Iniciar servidor HTTP
    servidor = app.listen(PORT, () => {
      logger.info(`
╔════════════════════════════════════════╗
║          CREA OS Backend API           ║
╠════════════════════════════════════════╣
║  Puerto  : ${PORT}
║  Entorno : ${process.env.NODE_ENV}
║  Versión : v1.0.0
╚════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    logger.error('❌ Error fatal al iniciar el servidor:', error);
    process.exit(1);
  }
};

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
const apagar = async (señal) => {
  logger.info(`\n${señal} recibido. Cerrando servidor limpiamente...`);

  if (servidor) {
    servidor.close(async () => {
      try {
        const { disconnectMongoDB } = require('./src/config/database');
        const { disconnectRedis } = require('./src/config/redis');

        await disconnectMongoDB();
        await disconnectRedis();

        logger.info('✅ Servidor apagado correctamente');
        process.exit(0);
      } catch (err) {
        logger.error('Error durante el apagado:', err);
        process.exit(1);
      }
    });
  }
};

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));

// Capturar errores no manejados (últimos recursos)
process.on('unhandledRejection', (err) => {
  logger.error('⚠️  UnhandledRejection:', err);
  apagar('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error('💥 UncaughtException:', err);
  process.exit(1);
});

iniciar();
