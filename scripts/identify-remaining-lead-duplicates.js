/**
 * SOLO LECTURA — identifica TODOS los grupos de leads activos duplicados
 * (mismo negocio, mismo teléfono normalizado) en toda la base, con el
 * detalle de actividad/conversación/notas/AutomationLog de cada lado, para
 * decidir manualmente cuál conservar. No borra ni fusiona nada.
 *
 * Complementa scripts/propose-phone-backfill.js (que ya resolvió los
 * duplicados de Myrel Company en Fase 0) — este script mira TODA la base
 * actual, post-fusión de negocios, con foco en el grupo "Moises Ramos"
 * (Problema 4) y cualquier otro que exista.
 *
 * Uso:
 *   node scripts/identify-remaining-lead-duplicates.js
 *   railway run node scripts/identify-remaining-lead-duplicates.js
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');
const { normalizeToE164 } = require('../src/utils/phone');

const Business = require('../src/modules/businesses/business.model');
const Lead = require('../src/modules/leads/lead.model');
const Conversation = require('../src/modules/ai/conversation.model');
const AutomationLog = require('../src/modules/automations/automation-log.model');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado (solo lectura)');

  const businesses = await Business.find({}, '_id name').lean();
  const businessNameById = new Map(businesses.map((b) => [String(b._id), b.name]));

  const allLeads = await Lead.find({}, '_id business name phone isDeleted createdAt activity notes').lean();

  // Agrupa SOLO leads activos por (business, teléfono normalizado).
  const groups = new Map();
  for (const l of allLeads) {
    if (l.isDeleted) continue;
    const normalized = normalizeToE164(l.phone);
    if (!normalized) continue;
    const key = `${l.business}|${normalized}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  const allDupIds = duplicateGroups.flat().map((l) => l._id);
  const convs = await Conversation.find({ lead: { $in: allDupIds } }, 'lead messages status').lean();
  const convByLead = new Map();
  for (const c of convs) {
    const key = String(c.lead);
    if (!convByLead.has(key)) convByLead.set(key, []);
    convByLead.get(key).push(c);
  }
  const autoLogs = await AutomationLog.find({ lead: { $in: allDupIds } }, 'lead automation status createdAt').lean();
  const autoLogsByLead = new Map();
  for (const a of autoLogs) {
    const key = String(a.lead);
    if (!autoLogsByLead.has(key)) autoLogsByLead.set(key, []);
    autoLogsByLead.get(key).push(a);
  }

  function enrich(l) {
    const leadConvs = convByLead.get(String(l._id)) || [];
    const totalMessages = leadConvs.reduce((sum, c) => sum + (c.messages?.length || 0), 0);
    const logs = autoLogsByLead.get(String(l._id)) || [];
    return {
      leadId: String(l._id),
      name: l.name,
      phone: l.phone,
      createdAt: l.createdAt,
      activityCount: (l.activity || []).length,
      notesCount: (l.notes || []).length,
      notes: (l.notes || []).map((n) => n.content),
      conversationCount: leadConvs.length,
      conversationIds: leadConvs.map((c) => String(c._id)),
      totalMessages,
      automationLogCount: logs.length,
      automationLogIds: logs.map((a) => String(a._id)),
    };
  }

  const report = duplicateGroups.map((group) => {
    const enriched = group.map(enrich).sort((a, b) => {
      if (b.totalMessages !== a.totalMessages) return b.totalMessages - a.totalMessages;
      if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
    return {
      business: businessNameById.get(String(group[0].business)),
      businessId: String(group[0].business),
      phone: normalizeToE164(group[0].phone),
      candidateToKeep: { leadId: enriched[0].leadId, name: enriched[0].name, reason: enriched[0].totalMessages > 0 ? 'tiene conversación/mensajes reales' : enriched[0].activityCount > (enriched[1]?.activityCount || 0) ? 'más actividad registrada' : 'el más antiguo, sin otra señal' },
      candidatesToDiscard: enriched.slice(1).map((l) => ({ ...l, hasDependentData: l.conversationCount > 0 || l.notesCount > 0 || l.automationLogCount > 0 })),
      leadsInGroup: enriched,
    };
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'remaining-lead-duplicates.json');
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), duplicateGroupsCount: report.length, groups: report }, null, 2));

  logger.info(`── ${report.length} grupo(s) de leads activos duplicados encontrados en TODA la base ──`);
  for (const g of report) {
    logger.info(`  ${g.business} / ${g.phone}: conservar "${g.candidateToKeep.name}" (${g.candidateToKeep.leadId}) — ${g.candidateToKeep.reason}. Descartables: ${g.candidatesToDiscard.length}`);
    for (const d of g.candidatesToDiscard) {
      if (d.hasDependentData) logger.warn(`    ⚠️  ${d.leadId} (${d.name}) tiene datos dependientes: conversaciones=${d.conversationCount}, notas=${d.notesCount}, automationLogs=${d.automationLogCount}`);
    }
  }
  logger.info(`✓ Reporte completo guardado en: ${outFile}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error identificando duplicados:', err.message);
  process.exit(1);
});
