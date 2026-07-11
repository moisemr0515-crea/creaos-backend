require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const WebhookConfig = require('../src/modules/webhooks/webhookConfig.model');
const logger = require('../src/utils/logger');

const BUSINESS_ID = '6a40bea469dd20b2f8b405a3'; // CRM Business

const newPageId = process.argv[2];

if (!newPageId) {
  logger.error('❌ Uso: node scripts/update-gupshup-pageid.js <nuevoPageId>');
  logger.error('   nuevoPageId: gs_app_id, entry[].id (WABA id) o phone_number_id del payload real recibido en Railway.');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  const config = await WebhookConfig.findOne({ platform: 'gupshup', business: BUSINESS_ID });
  if (!config) {
    logger.error(`❌ No se encontró WebhookConfig gupshup para business ${BUSINESS_ID}`);
    process.exit(1);
  }

  logger.info(`  pageId actual: "${config.pageId}"`);
  logger.info(`  pageId nuevo:  "${newPageId}"`);

  config.pageId = newPageId;
  await config.save();

  logger.info(`✓ WebhookConfig actualizado: ${config._id} (pageId=${config.pageId}, isActive=${config.isActive})`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error actualizando pageId:', err.message);
  process.exit(1);
});
