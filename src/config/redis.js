const Redis = require('ioredis');
const { REDIS_URL } = require('./env');
const logger = require('../utils/logger');

let redisClient = null;

/**
 * Crea y conecta el cliente Redis.
 * Usa ioredis con reconexión automática.
 */
const connectRedis = async () => {
  return new Promise((resolve, reject) => {
    const client = new Redis(REDIS_URL, {
      // Reintentar conexión con backoff exponencial
      retryStrategy: (times) => {
        if (times > 10) {
          logger.error('❌ Redis: demasiados intentos de reconexión');
          return null; // Detener reintentos
        }
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true,
      enableReadyCheck: true,
    });

    client.on('connect', () => {
      logger.info('✅ Redis conectado');
    });

    client.on('ready', () => {
      redisClient = client;
      resolve(client);
    });

    client.on('error', (err) => {
      logger.error('❌ Redis error:', err.message);
    });

    client.on('close', () => {
      logger.warn('⚠️  Redis conexión cerrada');
    });

    // Conectar explícitamente
    client.connect().catch(reject);
  });
};

/**
 * Devuelve el cliente Redis activo.
 * Lanza error si no está conectado.
 */
const getRedis = () => {
  if (!redisClient) {
    throw new Error('Redis no está conectado. Llama connectRedis() primero.');
  }
  return redisClient;
};

/**
 * Cierra la conexión Redis limpiamente.
 */
const disconnectRedis = async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis desconectado limpiamente');
  }
};

module.exports = { connectRedis, getRedis, disconnectRedis };
