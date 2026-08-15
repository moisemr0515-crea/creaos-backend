/**
 * SOLO LECTURA — identifica candidatos a hard delete: los 12 leads
 * soft-deleted que son duplicados de uno de los 3 números canónicos ya
 * decididos. Este script NO borra nada — solo lista y reporta.
 *
 * Criterios (los 3 deben cumplirse):
 *   1. isDeleted: true
 *   2. phone (ya normalizado a E.164 por el backfill de Paso A) coincide
 *      con uno de los 3 números canónicos
 *   3. NO es ninguno de los 3 leads canónicos (por _id, no por número —
 *      así se descarta explícitamente incluso si en el futuro alguno de
 *      los canónicos cambiara de número por algún motivo)
 *
 * Uso:
 *   node scripts/identify-hard-delete-candidates.js
 *   railway run node scripts/identify-hard-delete-candidates.js   (producción)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');

const Lead = require('../src/modules/leads/lead.model');
const Business = require('../src/modules/businesses/business.model');

const CANONICAL_PHONES = ['+51922800127', '+51923523382', '+51949394656'];
const CANONICAL_LEAD_IDS = ['6a52eb067e51be411da7066b', '6a52eb077e51be411da70673', '6a52eb087e51be411da7067b'];

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado (solo lectura)');

  const candidates = await Lead.find({
    isDeleted: true,
    phone: { $in: CANONICAL_PHONES },
    _id: { $nin: CANONICAL_LEAD_IDS },
  }, '_id business phone isDeleted createdAt name').lean();

  const businesses = await Business.find({}, '_id name').lean();
  const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

  const list = candidates.map((l) => ({
    leadId: String(l._id),
    name: l.name,
    business: businessNameById.get(String(l.business)),
    phone: l.phone,
    isDeleted: l.isDeleted,
    createdAt: l.createdAt,
  })).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  logger.info(`── ${list.length} candidatos a hard delete encontrados ──`);
  for (const c of list) {
    logger.info(`  ${c.leadId} | ${c.business} | "${c.name}" | ${c.phone} | isDeleted=${c.isDeleted} | ${c.createdAt}`);
  }

  // Verificación cruzada: confirma que los 3 canónicos efectivamente NO
  // aparecen en la lista (por si alguno de sus _id estuviera mal escrito).
  const canonicalStillPresent = list.filter((c) => CANONICAL_LEAD_IDS.includes(c.leadId));
  if (canonicalStillPresent.length > 0) {
    logger.error(`🚨 ALERTA: ${canonicalStillPresent.length} lead(s) canónico(s) aparecen en la lista de candidatos — revisar antes de continuar`);
  } else {
    logger.info('✓ Verificado: ninguno de los 3 leads canónicos está en la lista de candidatos.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'hard-delete-candidates.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    canonicalPhones: CANONICAL_PHONES,
    canonicalLeadIds: CANONICAL_LEAD_IDS,
    candidateCount: list.length,
    canonicalStillPresentInList: canonicalStillPresent.length,
    candidates: list,
  }, null, 2));

  logger.info(`✓ Reporte guardado en: ${outFile}`);
  logger.info('  Este script NO borró nada — es solo identificación para revisión.');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error identificando candidatos:', err.message);
  process.exit(1);
});
