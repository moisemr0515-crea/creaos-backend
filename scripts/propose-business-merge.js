/**
 * PROPUESTA de fusión CREA OS ← Myrel Company — solo lectura, mismo patrón
 * que propose-phone-backfill.js. Nunca escribe en la base — genera un
 * reporte JSON con todo lo necesario para revisar y aprobar antes de
 * ejecutar cualquier cambio real.
 *
 * Plan aprobado (ver conversación): CREA OS sobrevive como negocio final.
 * Myrel Company se fusiona hacia adentro.
 *
 * Qué genera:
 *   1. Grupos de leads por número de teléfono, cruzando CREA OS y Myrel
 *      Company — con el detalle de actividad/conversación de cada lado
 *      (para que la persona decida, no el script).
 *   2. El lead "raro" de Myrel Company (901781253, el número de la propia
 *      plataforma) — evidencia de por qué parece un residuo, no un lead real.
 *   3. Plan de movimiento de Pipeline y DailyMission (Myrel → CREA OS).
 *   4. Verificación de referencias huérfanas antes de desactivar el User
 *      moises@creaos.com (Lead.assignedTo, Lead.activity.performedBy,
 *      Conversation.messages.metadata.agentId).
 *   5. El cambio propuesto de Business del User real (moisemr0515@gmail.com).
 *
 * Uso:
 *   node scripts/propose-business-merge.js
 *   railway run node scripts/propose-business-merge.js   (producción, solo lectura)
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
const Pipeline = require('../src/modules/pipeline/pipeline.model');
const DailyMission = require('../src/modules/missions/dailyMission.model');
const User = require('../src/modules/users/user.model');

const CREA_OS = '6a3a028d8f0b137e53a05b82';
const MYREL = '6a52de897e51be411da70623';
const REAL_USER_ID = '6a52de897e51be411da70626'; // moisemr0515@gmail.com, hoy en Myrel Company
const SURPLUS_USER_ID = '6a3a028e8f0b137e53a05b85'; // moises@creaos.com, candidato a desactivar
const PLATFORM_PHONE = '+51901781253';

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado (solo lectura — este script no escribe nada)');

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Leads de ambos negocios, agrupados por teléfono
  // ═══════════════════════════════════════════════════════════════════════
  const leads = await Lead.find({ business: { $in: [CREA_OS, MYREL] } }, '_id business name phone isDeleted createdAt lastContactedAt activity assignedTo').lean();

  const conversations = await Conversation.find({ business: { $in: [CREA_OS, MYREL] } }, '_id business lead status messages assignedTo').lean();
  const convByLead = new Map();
  for (const c of conversations) {
    const key = String(c.lead);
    if (!convByLead.has(key)) convByLead.set(key, []);
    convByLead.get(key).push(c);
  }

  function enrichLead(l) {
    const convs = convByLead.get(String(l._id)) || [];
    const totalMessages = convs.reduce((sum, c) => sum + (c.messages?.length || 0), 0);
    const agentMessageAuthors = [...new Set(
      convs.flatMap((c) => c.messages || [])
        .filter((m) => m.metadata?.agentId)
        .map((m) => String(m.metadata.agentId))
    )];
    return {
      leadId: String(l._id),
      business: String(l.business) === CREA_OS ? 'CREA OS' : 'Myrel Company',
      businessId: String(l.business),
      name: l.name,
      phone: l.phone,
      isDeleted: l.isDeleted,
      createdAt: l.createdAt,
      lastContactedAt: l.lastContactedAt || null,
      activityCount: (l.activity || []).length,
      conversationCount: convs.length,
      totalMessages,
      conversationIds: convs.map((c) => String(c._id)),
      assignedTo: l.assignedTo ? String(l.assignedTo) : null,
      agentMessageAuthors,
    };
  }

  const enriched = leads.map(enrichLead);
  const groups = new Map();
  for (const l of enriched) {
    if (!groups.has(l.phone)) groups.set(l.phone, []);
    groups.get(l.phone).push(l);
  }

  const crossBusinessGroups = [];
  const myrelOnlyGroups = [];
  for (const [phone, group] of groups) {
    const businesses = new Set(group.map((l) => l.business));
    if (phone === PLATFORM_PHONE) continue; // se maneja aparte, más abajo
    if (businesses.size > 1) {
      // Conflicto real: el mismo número existe en ambos negocios — hay que decidir canónico.
      const sorted = [...group].sort((a, b) => {
        if (b.totalMessages !== a.totalMessages) return b.totalMessages - a.totalMessages;
        if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
      crossBusinessGroups.push({
        phone,
        suggestedCanonical: { leadId: sorted[0].leadId, business: sorted[0].business, name: sorted[0].name, reason: sorted[0].totalMessages > (sorted[1]?.totalMessages || 0) ? 'más mensajes de conversación real' : sorted[0].activityCount > (sorted[1]?.activityCount || 0) ? 'más actividad registrada' : 'el más antiguo (sin otra señal que lo diferencie)' },
        leadsInGroup: sorted,
        note: 'SUGERENCIA únicamente — requiere tu confirmación explícita antes de aplicar. Ver el detalle de actividad de cada lado.',
      });
    } else if (businesses.has('Myrel Company')) {
      // Solo existe en Myrel Company — se mueve a CREA OS sin conflicto.
      myrelOnlyGroups.push({ phone, leads: group, action: 'mover a CREA OS sin cambios, no hay equivalente del lado de CREA OS' });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. El lead "raro": Crea OS / +51901781253 en Myrel Company
  // ═══════════════════════════════════════════════════════════════════════
  const oddLead = leads.find((l) => l.phone === PLATFORM_PHONE);
  const oddLeadEnriched = oddLead ? enrichLead(oddLead) : null;
  const creaOsHasSamePhone = leads.some((l) => l.phone === PLATFORM_PHONE && String(l.business) === CREA_OS);

  const oddLeadAnalysis = oddLeadEnriched && {
    ...oddLeadEnriched,
    justificacion: [
      `El teléfono ${PLATFORM_PHONE} es el número compartido de la plataforma (WhatsAppChannel PLATFORM, WebhookConfig de Gupshup) — no un número de cliente real.`,
      `El lead se creó con source:'manual' (no 'whatsapp'), lo que indica que alguien lo tipeó a mano en el CRM, no que llegó por un mensaje real entrante.`,
      `Nombre del lead: "${oddLeadEnriched.name}" — literalmente "Crea OS", coincide con el nombre del negocio de la plataforma, no con un nombre de persona/cliente.`,
      `conversationCount: ${oddLeadEnriched.conversationCount}, totalMessages: ${oddLeadEnriched.totalMessages} — sin actividad de conversación real.`,
      `¿CREA OS tiene también un lead con este mismo número? ${creaOsHasSamePhone ? 'SÍ — revisar ese también' : 'NO — no hay conflicto de fusión con este, solo se propone soft-delete directo (no mover)'}`,
    ],
    proposedAction: 'soft-delete (no mover a CREA OS)',
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Pipeline y DailyMission de Myrel Company → mover a CREA OS
  // ═══════════════════════════════════════════════════════════════════════
  const pipelines = await Pipeline.find({ business: MYREL }, '_id name stages isDefault').lean();
  const dailyMissions = await DailyMission.find({ business: MYREL }, '_id date missions').lean();

  const creaOsHasPipeline = await Pipeline.countDocuments({ business: CREA_OS });
  const creaOsHasDailyMissionToday = await DailyMission.countDocuments({ business: CREA_OS });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Referencias huérfanas si se desactiva el User sobrante
  // ═══════════════════════════════════════════════════════════════════════
  const surplusUser = await User.findById(SURPLUS_USER_ID, '_id email business isActive').lean();
  const realUser = await User.findById(REAL_USER_ID, '_id email business isActive').lean();

  const leadsAssignedToSurplus = await Lead.find({ assignedTo: SURPLUS_USER_ID }, '_id name business').lean();
  const leadsWithActivityBySurplus = await Lead.find({ 'activity.performedBy': SURPLUS_USER_ID }, '_id name business').lean();
  const convsWithAgentMessagesBySurplus = await Conversation.find({ 'messages.metadata.agentId': SURPLUS_USER_ID }, '_id business lead').lean();

  const orphanCheck = {
    surplusUserId: SURPLUS_USER_ID,
    surplusUserEmail: surplusUser?.email,
    leadsAssignedToSurplus: leadsAssignedToSurplus.map((l) => ({ leadId: String(l._id), name: l.name, business: String(l.business) })),
    leadsWithActivityBySurplus: leadsWithActivityBySurplus.map((l) => ({ leadId: String(l._id), name: l.name, business: String(l.business) })),
    conversationsWithAgentMessagesBySurplus: convsWithAgentMessagesBySurplus.map((c) => ({ conversationId: String(c._id), business: String(c.business), lead: String(c.lead) })),
    safeToDeactivate: leadsAssignedToSurplus.length === 0 && leadsWithActivityBySurplus.length === 0 && convsWithAgentMessagesBySurplus.length === 0,
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Cambio de negocio del User real
  // ═══════════════════════════════════════════════════════════════════════
  const realUserChange = {
    userId: REAL_USER_ID,
    email: realUser?.email,
    currentBusiness: realUser?.business ? String(realUser.business) : null,
    proposedBusiness: CREA_OS,
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Guardar reporte
  // ═══════════════════════════════════════════════════════════════════════
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'business-merge-proposal.json');

  const report = {
    generatedAt: new Date().toISOString(),
    plan: 'CREA OS sobrevive, Myrel Company se fusiona hacia adentro',
    survivingBusinessId: CREA_OS,
    mergedBusinessId: MYREL,
    step1_crossBusinessLeadGroups: crossBusinessGroups,
    step1b_myrelOnlyLeadGroups: myrelOnlyGroups,
    step2_oddLead: oddLeadAnalysis,
    step3_pipelineAndMissionsMove: {
      pipelinesToMove: pipelines.map((p) => ({ pipelineId: String(p._id), name: p.name, stagesCount: p.stages?.length || 0, isDefault: p.isDefault })),
      dailyMissionsToMove: dailyMissions.map((d) => ({ missionId: String(d._id), date: d.date, missionsCount: d.missions?.length || 0 })),
      warningCreaOsAlreadyHasPipeline: creaOsHasPipeline > 0 ? `⚠️ CREA OS ya tiene ${creaOsHasPipeline} Pipeline(s) — revisar conflicto antes de mover` : 'CREA OS no tiene Pipeline propio, sin conflicto',
      warningCreaOsAlreadyHasDailyMission: creaOsHasDailyMissionToday > 0 ? `⚠️ CREA OS ya tiene ${creaOsHasDailyMissionToday} DailyMission(s) — revisar conflicto de fecha antes de mover` : 'CREA OS no tiene DailyMission propio, sin conflicto',
    },
    step4_surplusUserOrphanCheck: orphanCheck,
    step5_realUserBusinessChange: realUserChange,
  };

  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  // ── Resumen en consola ────────────────────────────────────────────────
  logger.info(`── ${crossBusinessGroups.length} grupo(s) de leads en conflicto (mismo número, ambos negocios) ──`);
  for (const g of crossBusinessGroups) {
    logger.info(`  ${g.phone}: ${g.leadsInGroup.length} leads en el grupo, sugerido = "${g.suggestedCanonical.name}" (${g.suggestedCanonical.business}) — ${g.suggestedCanonical.reason}`);
  }
  logger.info(`── ${myrelOnlyGroups.length} grupo(s) de Myrel Company sin conflicto (se mueven directo) ──`);
  logger.info(`── Lead raro (${PLATFORM_PHONE}): ${oddLead ? 'encontrado, ver justificación en el reporte' : 'NO encontrado (¿ya no existe?)'} ──`);
  logger.info(`── Pipeline a mover: ${pipelines.length} | DailyMission a mover: ${dailyMissions.length} ──`);
  logger.info(`── ¿Seguro desactivar User sobrante (${SURPLUS_USER_ID})? ${orphanCheck.safeToDeactivate ? 'SÍ, sin referencias huérfanas encontradas' : 'NO — hay referencias que revisar primero, ver detalle'} ──`);
  logger.info(`── User real (${REAL_USER_ID}): business actual = ${realUserChange.currentBusiness}, propuesto = ${realUserChange.proposedBusiness} ──`);
  logger.info(`✓ Reporte completo guardado en: ${outFile}`);
  logger.info('  Este script NO modificó ningún documento — es solo una propuesta para revisión.');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error generando la propuesta de fusión:', err.message);
  process.exit(1);
});
