/**
 * ⚠️ HARD DELETE PERMANENTE — IRREVERSIBLE salvo restaurar desde backup.
 *
 * Borra definitivamente los 12 leads soft-deleted que son duplicados de los
 * 3 números canónicos ya decididos y confirmados visualmente por el
 * usuario (ver scripts/identify-hard-delete-candidates.js y el reporte
 * backups/2026-08-15T17-00-23-335Z/hard-delete-candidates.json).
 *
 * Restaurar si algo sale mal:
 *   node scripts/restore-whatsapp-backup.js backups/2026-08-15T16-40-46-177Z
 *
 * Seguridad:
 *  - Lista de IDs HARDCODEADA (exactamente los 12 ya confirmados) — no una
 *    query dinámica, para que un cambio de datos entre la identificación y
 *    el borrado no amplíe el alcance sin querer.
 *  - Antes de borrar, vuelve a verificar CADA ID contra la base (no confía
 *    en la lista a ciegas): existe, isDeleted:true, phone es uno de los 3
 *    canónicos, y NO es ninguno de los 3 leads canónicos. Si un solo ID no
 *    calza, aborta sin borrar nada.
 *  - deleteOne por cada lead (no deleteMany masivo), con log de cada uno.
 *
 * Uso:
 *   node scripts/hard-delete-duplicate-leads.js
 *   railway run node scripts/hard-delete-duplicate-leads.js   (producción — IRREVERSIBLE)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');

const Lead = require('../src/modules/leads/lead.model');

const CANONICAL_PHONES = ['+51922800127', '+51923523382', '+51949394656'];
const CANONICAL_LEAD_IDS = ['6a52eb067e51be411da7066b', '6a52eb077e51be411da70673', '6a52eb087e51be411da7067b'];

// Los 12 IDs exactos confirmados visualmente por el usuario en chat
// (backups/2026-08-15T17-00-23-335Z/hard-delete-candidates.json).
const TO_DELETE = [
  '6a52f2b27e51be411da70817',
  '6a52f2b47e51be411da7081f',
  '6a52f2b57e51be411da70827',
  '6a5300ab19db8394481d8ed2',
  '6a5300ac19db8394481d8eda',
  '6a5300ad19db8394481d8ee2',
  '6a5309e319db8394481d95ed',
  '6a5309e519db8394481d95f5',
  '6a5309e619db8394481d95fd',
  '6a55aa091b3088e619d07b47',
  '6a55aa0a1b3088e619d07b4f',
  '6a55aa0b1b3088e619d07b57',
];

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');
  logger.info(`⚠️  Este script va a BORRAR PERMANENTEMENTE ${TO_DELETE.length} leads. Verificando cada uno antes de borrar...`);

  // Verificación cruzada — cada ID debe recumplir los 3 criterios
  // originales, re-consultando la base (no confiar en la lista hardcodeada
  // a ciegas). Si algo no calza, se aborta SIN BORRAR NADA.
  const problems = [];
  const verified = [];
  for (const id of TO_DELETE) {
    if (CANONICAL_LEAD_IDS.includes(id)) {
      problems.push(`${id}: es uno de los 3 leads canónicos — NUNCA debe borrarse`);
      continue;
    }
    const lead = await Lead.findById(id, '_id business phone isDeleted name').lean();
    if (!lead) {
      problems.push(`${id}: no existe en la base (¿ya se borró antes?)`);
      continue;
    }
    if (lead.isDeleted !== true) {
      problems.push(`${id}: isDeleted es ${lead.isDeleted}, no true — no calza con el criterio original`);
      continue;
    }
    if (!CANONICAL_PHONES.includes(lead.phone)) {
      problems.push(`${id}: phone es "${lead.phone}", no es uno de los 3 números canónicos`);
      continue;
    }
    verified.push(lead);
  }

  if (problems.length > 0) {
    logger.error(`🚨 ABORTANDO — ${problems.length} problema(s) encontrados, NO se borró nada:`);
    problems.forEach((p) => logger.error(`  - ${p}`));
    await mongoose.disconnect();
    process.exit(1);
  }

  if (verified.length !== TO_DELETE.length) {
    logger.error(`🚨 ABORTANDO — se verificaron ${verified.length} de ${TO_DELETE.length} esperados, no coincide, NO se borró nada`);
    await mongoose.disconnect();
    process.exit(1);
  }

  logger.info(`✓ Los ${verified.length} leads pasaron la verificación cruzada. Borrando...`);

  let deletedCount = 0;
  for (const lead of verified) {
    const result = await Lead.deleteOne({ _id: lead._id });
    if (result.deletedCount === 1) {
      deletedCount += 1;
      logger.info(`  🗑️  Borrado permanentemente: ${lead._id} (${lead.name}, ${lead.phone})`);
    } else {
      logger.warn(`  ⚠ No se pudo borrar ${lead._id} (deletedCount=${result.deletedCount})`);
    }
  }

  logger.info(`✓ Hard delete completo: ${deletedCount}/${TO_DELETE.length} leads borrados permanentemente.`);
  logger.info('  Para restaurar si hiciera falta: node scripts/restore-whatsapp-backup.js backups/2026-08-15T16-40-46-177Z');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error en el hard delete:', err.message);
  process.exit(1);
});
