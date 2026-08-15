/**
 * Restaura un backup generado por scripts/backup-whatsapp-data.js.
 *
 * Hace upsert por _id (no borra nada que no esté en el backup, no toca
 * documentos creados después del backup salvo que compartan _id con uno
 * respaldado). Pensado como red de seguridad manual para la sub-fase 0.a,
 * no como una herramienta de rollback automática.
 *
 * Uso:
 *   node scripts/restore-whatsapp-backup.js backups/<timestamp>
 *   railway run node scripts/restore-whatsapp-backup.js backups/<timestamp>   (contra producción)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');

const Business = require('../src/modules/businesses/business.model');
const Lead = require('../src/modules/leads/lead.model');
const Conversation = require('../src/modules/ai/conversation.model');
const WebhookConfig = require('../src/modules/webhooks/webhookConfig.model');
const WhatsAppConnection = require('../src/modules/whatsapp/whatsappConnection.model');

const MODELS_BY_COLLECTION = {
  businesses: Business,
  leads: Lead,
  conversations: Conversation,
  webhookconfigs: WebhookConfig,
  whatsappconnections: WhatsAppConnection,
};

const backupDirArg = process.argv[2];

if (!backupDirArg) {
  logger.error('❌ Uso: node scripts/restore-whatsapp-backup.js <ruta-al-backup>');
  logger.error('   Ejemplo: node scripts/restore-whatsapp-backup.js backups/2026-08-14T20-00-00-000Z');
  process.exit(1);
}

const run = async () => {
  const backupDir = path.resolve(process.cwd(), backupDirArg);
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    logger.error(`❌ No se encontró manifest.json en ${backupDir}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');
  logger.info(`   DB: ${mongoose.connection.name}`);
  logger.info(`   Restaurando backup de: ${manifest.createdAt}`);

  for (const { name, file } of manifest.collections) {
    const model = MODELS_BY_COLLECTION[name];
    if (!model) {
      logger.error(`  ⚠ Colección "${name}" no reconocida en este script, se salta`);
      continue;
    }
    const docs = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'));
    let restored = 0;
    for (const doc of docs) {
      await model.collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
      restored += 1;
    }
    logger.info(`  ${name}: ${restored}/${docs.length} documentos restaurados`);
  }

  logger.info('✓ Restauración completa');
  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error restaurando backup:', err.message);
  process.exit(1);
});
