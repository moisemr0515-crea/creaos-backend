const mongoose = require('mongoose');
const dns = require('dns');
const { MONGODB_URI, NODE_ENV } = require('./env');
const logger = require('../utils/logger');

// El router bloquea consultas SRV — forzar Google DNS para que mongodb+srv:// funcione
dns.setServers(['8.8.8.8', '1.1.1.1']);

/**
 * Conecta a MongoDB Atlas con manejo de reconexión automática.
 */
const connectMongoDB = async () => {
  try {
    const opciones = {
      // Deshabilitar el buffer cuando no hay conexión
      bufferCommands: false,
    };

    await mongoose.connect(MONGODB_URI, opciones);
    logger.info(`✅ MongoDB conectado: ${mongoose.connection.host}`);
  } catch (error) {
    logger.error('❌ Error conectando a MongoDB:', error.message);
    throw error;
  }
};

// Eventos de conexión para monitoreo
mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️  MongoDB desconectado');
});

mongoose.connection.on('reconnected', () => {
  logger.info('✅ MongoDB reconectado');
});

// En modo desarrollo, loguear queries
if (NODE_ENV === 'development') {
  mongoose.set('debug', (collectionName, method, query) => {
    logger.debug(`MongoDB ${collectionName}.${method}`, query);
  });
}

/**
 * Cierra la conexión de forma limpia (usado en tests y graceful shutdown).
 */
const disconnectMongoDB = async () => {
  await mongoose.connection.close();
  logger.info('MongoDB desconectado limpiamente');
};

module.exports = { connectMongoDB, disconnectMongoDB };
