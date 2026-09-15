const mongoose = require('mongoose');
const { getRedis } = require('../config/redis');

const HEALTH_TIMEOUT_MS = 1500;

const withTimeout = (promise, timeoutMs = HEALTH_TIMEOUT_MS) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('healthcheck timeout')), timeoutMs);
    timer.unref?.();
  }),
]);

async function checkCoreHealth({
  mongoConnection = mongoose.connection,
  redisProvider = getRedis,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const mongoCheck = async () => {
    if (mongoConnection.readyState !== 1 || !mongoConnection.db) throw new Error('mongo unavailable');
    await mongoConnection.db.admin().ping();
  };

  const redisCheck = async () => {
    const pong = await redisProvider().ping();
    if (pong !== 'PONG') throw new Error('redis unavailable');
  };

  const [mongo, redis] = await Promise.allSettled([
    withTimeout(mongoCheck(), timeoutMs),
    withTimeout(redisCheck(), timeoutMs),
  ]);

  const dependencies = {
    mongo: mongo.status === 'fulfilled' ? 'up' : 'down',
    redis: redis.status === 'fulfilled' ? 'up' : 'down',
  };

  return { ok: dependencies.mongo === 'up' && dependencies.redis === 'up', dependencies };
}

module.exports = { HEALTH_TIMEOUT_MS, withTimeout, checkCoreHealth };
