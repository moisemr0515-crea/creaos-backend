require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI, GUPSHUP_APP_NAME } = require('../src/config/env');
const WebhookConfig = require('../src/modules/webhooks/webhookConfig.model');
const logger = require('../src/utils/logger');

const BUSINESS_ID = '6a40bea469dd20b2f8b405a3'; // CRM Business

const seed = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  const config = await WebhookConfig.findOneAndUpdate(
    { platform: 'gupshup', pageId: GUPSHUP_APP_NAME },
    {
      business: BUSINESS_ID,
      platform: 'gupshup',
      pageId: GUPSHUP_APP_NAME,
      isActive: true,
      defaults: { source: 'whatsapp', temperature: 'warm' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logger.info(`✓ WebhookConfig Gupshup listo: ${config._id} (app=${config.pageId}, business=${config.business})`);

  await mongoose.disconnect();
};

seed().catch((err) => {
  logger.error('❌ Error en seed:', err.message);
  process.exit(1);
});
