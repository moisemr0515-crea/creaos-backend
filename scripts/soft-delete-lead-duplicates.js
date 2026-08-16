/**
 * Soft-delete de los 4 leads duplicados identificados y aprobados
 * (ver scripts/identify-remaining-lead-duplicates.js y la conversación de
 * aprobación). Mismo patrón de seguridad que Fase 0
 * (scripts/hard-delete-duplicate-leads.js), adaptado a soft-delete:
 *
 *  - IDs hardcodeados exactos (no una query dinámica).
 *  - Verificación cruzada de CADA lead antes de tocar nada: existe,
 *    isDeleted:false todavía, business correcto, phone correcto, name
 *    correcto. Si uno solo no calza, aborta sin tocar ningún documento.
 *  - Usa Lead.softDelete() real (mismo método que usa la app desde la UI)
 *    — no un $set crudo — para que quede con su propio registro de
 *    actividad, trazable.
 *  - Reversible: soft-delete, no hard-delete. Backup adicional disponible
 *    en backups/2026-08-16T01-05-52-119Z/ si hiciera falta.
 *
 * Uso:
 *   node scripts/soft-delete-lead-duplicates.js
 *   railway run node scripts/soft-delete-lead-duplicates.js
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');

const Lead = require('../src/modules/leads/lead.model');

const CREA_OS = '6a3a028d8f0b137e53a05b82';
const ACTOR_NAME = 'Limpieza de duplicados (Problema 4, script)';

const TO_DISCARD = [
  { leadId: '6a80fb65e4e302ff6e4ef045', expectedName: 'Moises Ramos', expectedPhone: '+51910265404', canonicalLeadId: '6a51d8ce272487d47c05c374' },
  { leadId: '6a80e051ffd8524147d1a41a', expectedName: 'Moises Ramos', expectedPhone: '+51910265404', canonicalLeadId: '6a51d8ce272487d47c05c374' },
  { leadId: '6a80abacffd8524147d1a161', expectedName: 'Crea Emprendedores', expectedPhone: '+51922800127', canonicalLeadId: '6a54809b6a1b1ee32d9b53cc' },
  { leadId: '6a80fad9e4e302ff6e4eef7a', expectedName: 'Maritza Gutierrez', expectedPhone: '+51976900835', canonicalLeadId: '6a54811a6a1b1ee32d9b53d7' },
];

const CANONICALS = [
  { leadId: '6a51d8ce272487d47c05c374', expectedName: 'Moises Ramos', expectedPhone: '+51910265404' },
  { leadId: '6a54809b6a1b1ee32d9b53cc', expectedName: 'Crea Emprendedores', expectedPhone: '+51922800127' },
  { leadId: '6a54811a6a1b1ee32d9b53d7', expectedName: 'Vivir O Intentar Siempre', expectedPhone: '+51976900835' },
];

async function verifyAll() {
  const problems = [];

  for (const d of TO_DISCARD) {
    const lead = await Lead.findById(d.leadId).lean();
    if (!lead) { problems.push(`${d.leadId}: no existe`); continue; }
    if (lead.isDeleted) { problems.push(`${d.leadId}: ya está isDeleted:true`); continue; }
    if (String(lead.business) !== CREA_OS) problems.push(`${d.leadId}: business="${lead.business}", esperado CREA OS`);
    if (lead.name !== d.expectedName) problems.push(`${d.leadId}: name="${lead.name}", esperado "${d.expectedName}"`);
    if (lead.phone !== d.expectedPhone) problems.push(`${d.leadId}: phone="${lead.phone}", esperado "${d.expectedPhone}"`);
  }

  for (const c of CANONICALS) {
    const lead = await Lead.findById(c.leadId).lean();
    if (!lead) { problems.push(`canónico ${c.leadId}: no existe`); continue; }
    if (lead.isDeleted) problems.push(`canónico ${c.leadId}: está isDeleted:true — no debería tocarse, pero está mal`);
    if (lead.name !== c.expectedName) problems.push(`canónico ${c.leadId}: name="${lead.name}", esperado "${c.expectedName}"`);
    if (lead.phone !== c.expectedPhone) problems.push(`canónico ${c.leadId}: phone="${lead.phone}", esperado "${c.expectedPhone}"`);
  }

  return problems;
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');
  logger.info(`⚠️  Verificando ${TO_DISCARD.length} leads a descartar + ${CANONICALS.length} canónicos ANTES de tocar nada...`);

  const problems = await verifyAll();
  if (problems.length > 0) {
    logger.error(`🚨 ABORTANDO — ${problems.length} problema(s) encontrados, NO se tocó nada:`);
    problems.forEach((p) => logger.error(`  - ${p}`));
    await mongoose.disconnect();
    process.exit(1);
  }
  logger.info('✓ Verificación completa, todo coincide. Aplicando soft-delete uno por uno...');

  for (const d of TO_DISCARD) {
    const lead = await Lead.findById(d.leadId);
    lead.activity.push({
      type: 'updated',
      description: `Duplicado de ${d.canonicalLeadId} (${d.expectedName}) — descartado tras confirmación explícita, Problema 4`,
      performedBy: null,
      performedByName: ACTOR_NAME,
    });
    await lead.softDelete(null, ACTOR_NAME);
    logger.info(`  🗑️  Soft-deleted: ${d.leadId} (${d.expectedName}, ${d.expectedPhone}) — duplicado de ${d.canonicalLeadId}`);
  }

  logger.info(`✓ Limpieza completa: ${TO_DISCARD.length}/${TO_DISCARD.length} leads soft-deleted.`);
  logger.info('  Restaurar si hiciera falta: node scripts/restore-whatsapp-backup.js backups/2026-08-16T01-05-52-119Z');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error en la limpieza:', err.message);
  process.exit(1);
});
