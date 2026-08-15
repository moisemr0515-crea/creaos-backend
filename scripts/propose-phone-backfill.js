/**
 * PROPUESTA de backfill de normalización E.164 + deduplicación — Fase 0.
 *
 * Este script es 100% de solo lectura. NO modifica ni un solo documento de
 * Lead. Genera un reporte JSON con:
 *   1. Qué leads cambiarían de formato si se normalizara su `phone` a E.164
 *      (comparación, no escritura).
 *   2. Grupos de duplicados por número normalizado (mismo negocio).
 *   3. Para cada grupo, una propuesta de lead "canónico" con la razón —
 *      SIN fusionar nada. La fusión de conversaciones/históricos queda para
 *      revisión humana, no automatizada (Blueprint §7, Plan Maestro §24.6:
 *      "no reasignar automáticamente conversaciones históricas cuya
 *      pertenencia sea incierta").
 *
 * Criterio de "canónico" (en orden):
 *   a) NO estar isDeleted (un lead ya borrado no debería proponerse como
 *      canónico aunque tenga más actividad — hallazgo real de esta corrida:
 *      la mayoría de los "duplicados" detectados por report-phone-duplicates.js
 *      ya están soft-deleted, ver mensaje de resumen)
 *   b) Más Conversation asociadas (más señal de relación real)
 *   c) Si empatan, más entradas en Lead.activity (más interacción registrada)
 *   d) Si empatan, el más antiguo (createdAt) — el ObjectId más chico
 *
 * Uso:
 *   node scripts/propose-phone-backfill.js
 *   railway run node scripts/propose-phone-backfill.js   (contra producción, solo lectura)
 *
 * Este script NO tiene modo de escritura. El backfill real (dos pasos
 * separados y explícitos) es trabajo futuro, solo después de que se revise
 * y apruebe esta propuesta:
 *   - Paso A (seguro, sin ambigüedad): normalizar el campo `phone` de cada
 *     lead a E.164 — solo corrige el formato del string, no fusiona nada.
 *   - Paso B (requiere decisión humana, no automatizable): para cada grupo
 *     de duplicados, decidir caso por caso si se fusionan los leads o se
 *     dejan como están — usando esta propuesta como punto de partida, no
 *     como ejecución automática.
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
const Conversation = require('../src/modules/ai/conversation.model');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado (solo lectura — este script no escribe nada)');

  const leads = await Lead.find({}, '_id business phone name createdAt activity isDeleted').lean();
  const businesses = await Business.find({}, '_id name').lean();
  const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

  // ── 1. Qué cambiaría si se normalizara cada lead ─────────────────────────
  const wouldChange = [];
  for (const lead of leads) {
    const normalized = normalizeToE164(lead.phone);
    if (normalized && normalized !== lead.phone) {
      wouldChange.push({ leadId: String(lead._id), business: businessNameById.get(String(lead.business)), before: lead.phone, after: normalized });
    }
  }

  // ── 2. Agrupar por (business, teléfono normalizado) ──────────────────────
  const groups = new Map();
  for (const lead of leads) {
    const normalized = normalizeToE164(lead.phone);
    if (!normalized) continue;
    const key = `${lead.business}|${normalized}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...lead, normalizedPhone: normalized });
  }
  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  // ── 3. Enriquecer con conteo de conversaciones + proponer canónico ───────
  const allDupLeadIds = duplicateGroups.flat().map((l) => l._id);
  const convCounts = await Conversation.aggregate([
    { $match: { lead: { $in: allDupLeadIds } } },
    { $group: { _id: '$lead', count: { $sum: 1 } } },
  ]);
  const convCountByLead = new Map(convCounts.map((c) => [String(c._id), c.count]));

  const proposals = duplicateGroups.map((group) => {
    const enriched = group.map((l) => ({
      leadId: String(l._id),
      name: l.name,
      phone: l.phone,
      createdAt: l.createdAt,
      activityCount: (l.activity || []).length,
      conversationCount: convCountByLead.get(String(l._id)) || 0,
      isDeleted: l.isDeleted,
    }));

    // Ordena por el criterio de canónico: no-borrado > más conversaciones > más actividad > más antiguo
    const sorted = [...enriched].sort((a, b) => {
      if (a.isDeleted !== b.isDeleted) return a.isDeleted ? 1 : -1; // los no-borrados van primero
      if (b.conversationCount !== a.conversationCount) return b.conversationCount - a.conversationCount;
      if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
      return new Date(a.createdAt) - new Date(b.createdAt); // más antiguo primero
    });
    const canonical = sorted[0];
    const reason = !canonical.isDeleted && sorted.some((l) => l.isDeleted)
      ? 'es el único (o uno de los pocos) leads NO borrados del grupo'
      : canonical.conversationCount > 0
        ? 'más conversaciones asociadas'
        : canonical.activityCount > sorted[1]?.activityCount
          ? 'más actividad registrada'
          : 'el más antiguo (sin otra señal que lo diferencie)';

    return {
      business: businessNameById.get(String(group[0].business)),
      normalizedPhone: group[0].normalizedPhone,
      leads: enriched,
      proposedCanonicalLeadId: canonical.leadId,
      proposedCanonicalName: canonical.name,
      reason,
      note: 'PROPUESTA únicamente — ningún lead fue fusionado ni modificado. Requiere revisión y aprobación humana antes de cualquier acción.',
    };
  });

  // ── 4. Guardar reporte ────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'phone-backfill-proposal.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalLeads: leads.length,
    leadsThatWouldChangeFormat: wouldChange.length,
    duplicateGroupsCount: proposals.length,
    formatChanges: wouldChange,
    duplicateProposals: proposals,
  }, null, 2));

  const totalDupLeads = proposals.reduce((sum, p) => sum + p.leads.length, 0);
  const alreadyDeletedDupLeads = proposals.reduce((sum, p) => sum + p.leads.filter((l) => l.isDeleted).length, 0);

  logger.info(`── ${wouldChange.length} de ${leads.length} leads cambiarían de formato si se normalizaran ──`);
  logger.info(`── ${proposals.length} grupos de duplicados (${totalDupLeads} leads en total, ${alreadyDeletedDupLeads} ya isDeleted:true) ──`);
  for (const p of proposals) {
    logger.info(`  ${p.business} / ${p.normalizedPhone}: canónico propuesto = "${p.proposedCanonicalName}" (${p.proposedCanonicalLeadId}) — ${p.reason}`);
  }
  logger.info(`✓ Propuesta completa guardada en: ${outFile}`);
  logger.info('  Este script NO modificó ningún documento — es solo una propuesta para revisión.');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error generando la propuesta:', err.message);
  process.exit(1);
});
