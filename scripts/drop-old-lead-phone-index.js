/**
 * Borra el índice viejo no-único {business,phone} ("business_1_phone_1")
 * de la colección leads, ahora redundante desde que existe el índice único
 * parcial "business_1_phone_1_unique_active" (lead.model.js). No toca
 * ningún documento — solo metadata de índice. Seguro de correr más de una
 * vez (si el índice ya no existe, lo reporta y no hace nada).
 *
 * Uso:
 *   node scripts/drop-old-lead-phone-index.js
 *   railway run node scripts/drop-old-lead-phone-index.js
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');
const Lead = require('../src/modules/leads/lead.model');

const OLD_INDEX_NAME = 'business_1_phone_1';

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  const indexes = await Lead.collection.getIndexes();
  if (!indexes[OLD_INDEX_NAME]) {
    logger.info(`ℹ️  El índice "${OLD_INDEX_NAME}" ya no existe — nada que hacer.`);
    await mongoose.disconnect();
    return;
  }

  await Lead.collection.dropIndex(OLD_INDEX_NAME);
  logger.info(`✓ Índice "${OLD_INDEX_NAME}" eliminado.`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error borrando el índice viejo:', err.message);
  process.exit(1);
});
