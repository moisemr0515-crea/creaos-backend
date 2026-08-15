/**
 * Backup de solo lectura de las colecciones afectadas por la migración de
 * WhatsApp/Gupshup (Implementation Blueprint, sub-fase 0.a — Contención y backup).
 *
 * NO escribe nada en la base de datos. Exporta un snapshot JSON de cada
 * colección a disco, con timestamp, para poder restaurar manualmente si algo
 * sale mal durante las sub-fases 1.a en adelante.
 *
 * Uso:
 *   node scripts/backup-whatsapp-data.js
 *   railway run node scripts/backup-whatsapp-data.js   (contra producción)
 *
 * Los archivos quedan en backups/<timestamp>/ (ver .gitignore — nunca se commitean,
 * contienen datos personales de leads).
 *
 * Restauración (si hiciera falta revertir):
 *   node scripts/restore-whatsapp-backup.js backups/<timestamp>
 *   (ver ese script — hace upsert por _id, no borra nada que no esté en el backup)
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

// Colecciones respaldadas completas (no filtradas) — el volumen actual del
// proyecto es chico, y un backup completo es más simple de restaurar y más
// seguro que confiar en un filtro que podría dejar algo afuera.
const COLLECTIONS = [
  { name: 'businesses', model: Business },
  { name: 'leads', model: Lead },
  { name: 'conversations', model: Conversation },
  { name: 'webhookconfigs', model: WebhookConfig },
  { name: 'whatsappconnections', model: WhatsAppConnection },
];

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');
  logger.info(`   DB: ${mongoose.connection.name}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    createdAt: new Date().toISOString(),
    mongoDb: mongoose.connection.name,
    collections: [],
  };

  for (const { name, model } of COLLECTIONS) {
    const docs = await model.find({}).lean();
    const filePath = path.join(outDir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
    manifest.collections.push({ name, count: docs.length, file: `${name}.json` });
    logger.info(`  ${name}: ${docs.length} documentos → ${filePath}`);
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  logger.info(`✓ Backup completo en: ${outDir}`);
  logger.info(`  Para restaurar: node scripts/restore-whatsapp-backup.js ${path.relative(process.cwd(), outDir)}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error generando backup:', err.message);
  process.exit(1);
});
