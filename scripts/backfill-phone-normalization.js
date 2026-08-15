/**
 * Backfill — Paso A (Fase 0). Normaliza el campo `phone` a E.164 en los
 * leads existentes cuyo formato actual difiere del normalizado.
 *
 * Alcance ESTRICTO, según lo aprobado:
 *   - Solo corrige el string de `phone` — ningún otro campo se toca.
 *   - NO fusiona leads duplicados.
 *   - NO cambia `isDeleted` de ningún documento (los soft-deleted quedan
 *     soft-deleted, tal cual — Paso B, sin acción).
 *   - Update vía `updateOne({_id}, {$set:{phone}})` — bypassa el
 *     pre('save') del modelo a propósito, para garantizar que ningún otro
 *     middleware/hook toque nada más del documento.
 *
 * Idempotente: si se corre dos veces, la segunda vez no encuentra nada que
 * cambiar (el filtro es "el phone normalizado difiere del actual").
 *
 * Uso:
 *   node scripts/backfill-phone-normalization.js
 *   railway run node scripts/backfill-phone-normalization.js   (producción)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');
const { normalizeToE164 } = require('../src/utils/phone');

const Lead = require('../src/modules/leads/lead.model');
const Business = require('../src/modules/businesses/business.model');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  const leads = await Lead.find({}, '_id business phone isDeleted').lean();
  const businesses = await Business.find({}, '_id name').lean();
  const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

  const changes = [];
  for (const lead of leads) {
    const normalized = normalizeToE164(lead.phone);
    if (normalized && normalized !== lead.phone) {
      changes.push({
        leadId: String(lead._id),
        business: businessNameById.get(String(lead.business)),
        isDeleted: lead.isDeleted,
        before: lead.phone,
        after: normalized,
      });
    }
  }

  logger.info(`── ${changes.length} de ${leads.length} leads necesitan normalización ──`);

  let modifiedCount = 0;
  for (const change of changes) {
    const result = await Lead.updateOne({ _id: change.leadId }, { $set: { phone: change.after } });
    if (result.modifiedCount === 1) {
      modifiedCount += 1;
      logger.info(`  ✓ ${change.leadId} (${change.business}${change.isDeleted ? ', isDeleted' : ''}): "${change.before}" → "${change.after}"`);
    } else {
      logger.warn(`  ⚠ ${change.leadId}: updateOne no modificó nada (¿ya estaba normalizado?)`);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'phone-backfill-executed.json');
  fs.writeFileSync(outFile, JSON.stringify({
    executedAt: new Date().toISOString(),
    totalLeads: leads.length,
    candidatesFound: changes.length,
    modifiedCount,
    changes,
  }, null, 2));

  logger.info(`✓ Backfill completo: ${modifiedCount}/${changes.length} documentos modificados.`);
  logger.info(`  Reporte guardado en: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error en el backfill:', err.message);
  process.exit(1);
});
