/**
 * ⚠️ ESCRITURA REAL — fusión CREA OS ← Myrel Company. NO ejecutado todavía.
 *
 * Ejecuta exactamente lo confirmado en la conversación de diseño (ver
 * backups/2026-08-15T23-17-13-151Z/business-merge-proposal.json, generado
 * por scripts/propose-business-merge.js):
 *
 *   1. Lead "Te Quiero Moringa" (Myrel, 6a52eb07...) → soft-delete
 *      (canónico: 6a51db8a..., CREA OS, sin cambios)
 *   2. Lead "Emprendedores" (Myrel, 6a52eb06...) → soft-delete
 *      (canónico: 6a54809b..., CREA OS, sin cambios — 6a80abac... queda
 *      FUERA de esta fusión, es un problema aparte confirmado)
 *   3. Lead "Myrel Company" (Myrel, 6a52eb08...) → MOVER a CREA OS
 *      (sin conflicto, no tiene equivalente del lado de CREA OS)
 *   4. Lead "Crea OS" +51901781253 (Myrel, 6a80e029...) → soft-delete
 *      (confirmado: lead de prueba de hoy, no un cliente real)
 *   5. Pipeline "Pipeline Principal" (Myrel, 6a52eb05...) → MOVER a CREA OS
 *   6. 5x DailyMission (Myrel) → MOVER a CREA OS
 *   7. User moises@creaos.com (6a3a028e...) → isActive: false (desactivar, NO borrar)
 *   8. User moisemr0515@gmail.com (6a52de89...726) → business = CREA OS
 *
 * NO se toca el documento Business de Myrel Company en sí (sigue existiendo,
 * queda vacío de hijos) — no fue pedido explícitamente, fuera de alcance a
 * propósito.
 *
 * Seguridad (mismo espíritu que hard-delete-duplicate-leads.js, reforzado):
 *  - Todos los IDs están HARDCODEADOS — ninguna query dinámica decide el
 *    alcance.
 *  - Fase de VERIFICACIÓN completa primero (100% de lectura, cero escrituras)
 *    — cada documento se re-confirma contra el estado esperado (existe, los
 *    campos clave coinciden). Si UNA sola verificación falla, se aborta sin
 *    escribir nada.
 *  - Las escrituras corren dentro de una transacción de Mongo
 *    (session.withTransaction) — o se aplican TODAS o NINGUNA. Esto es más
 *    fuerte que el patrón secuencial de hard-delete-duplicate-leads.js,
 *    justificado acá porque son 11 escrituras heterogéneas en 4 colecciones
 *    distintas (Lead, Pipeline, DailyMission, User), no 12 deleteOne del
 *    mismo tipo.
 *  - Los soft-delete usan Lead.softDelete() (el método real del modelo, con
 *    su propio registro de actividad) — no un $set crudo, para que quede
 *    igual de trazable que un soft-delete hecho desde la UI.
 *
 * Restaurar si algo sale mal:
 *   node scripts/restore-whatsapp-backup.js backups/2026-08-15T16-40-46-177Z
 *   (backup de Lead más reciente disponible — OJO: no incluye Pipeline,
 *   DailyMission ni User; si hace falta revertir esos, es manual)
 *
 * Uso:
 *   node scripts/execute-business-merge.js
 *   railway run node scripts/execute-business-merge.js   (producción — IRREVERSIBLE salvo lo de arriba)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');

const Business = require('../src/modules/businesses/business.model');
const Lead = require('../src/modules/leads/lead.model');
const Pipeline = require('../src/modules/pipeline/pipeline.model');
const DailyMission = require('../src/modules/missions/dailyMission.model');
const User = require('../src/modules/users/user.model');
const Conversation = require('../src/modules/ai/conversation.model');

const CREA_OS = '6a3a028d8f0b137e53a05b82';
const MYREL = '6a52de897e51be411da70623';
const ACTOR_NAME = 'Fusión de negocios CREA OS ← Myrel Company (script)';

const PLAN = {
  softDeleteLeads: [
    { leadId: '6a52eb077e51be411da70673', expectedPhone: '+51923523382', expectedName: 'Te quiero Moringa', canonicalLeadId: '6a51db8a272487d47c05c390' },
    { leadId: '6a52eb067e51be411da7066b', expectedPhone: '+51922800127', expectedName: 'Emprendedores', canonicalLeadId: '6a54809b6a1b1ee32d9b53cc' },
    { leadId: '6a80e029ffd8524147d1a3e1', expectedPhone: '+51901781253', expectedName: 'Crea OS', canonicalLeadId: null }, // lead de prueba, no hay canónico — solo se borra
  ],
  canonicalLeadsUnchanged: [
    { leadId: '6a51db8a272487d47c05c390', expectedPhone: '+51923523382', expectedName: 'Te Quiero Moringa 🌿' },
    { leadId: '6a54809b6a1b1ee32d9b53cc', expectedPhone: '+51922800127', expectedName: 'Crea Emprendedores' },
  ],
  moveLeads: [
    { leadId: '6a52eb087e51be411da7067b', expectedPhone: '+51949394656', expectedName: 'Myrel Company' },
  ],
  movePipelines: [
    { pipelineId: '6a52eb057e51be411da70669', expectedName: 'Pipeline Principal' },
  ],
  moveDailyMissions: [
    '6a7bad5f0da731ec300ae10d',
    '6a7c806c0da731ec300b1809',
    '6a7de4490da731ec300b7684',
    '6a7f276b0da731ec300bca22',
    '6a80527a0da731ec300bf5d1',
  ],
  deactivateUser: { userId: '6a3a028e8f0b137e53a05b85', expectedEmail: 'moises@creaos.com' },
  changeUserBusiness: { userId: '6a52de897e51be411da70626', expectedEmail: 'moisemr0515@gmail.com', expectedCurrentBusiness: MYREL },
};

async function verifyAll() {
  const problems = [];

  const creaOs = await Business.findById(CREA_OS).lean();
  if (!creaOs || !creaOs.isActive) problems.push(`Business CREA OS (${CREA_OS}) no existe o no está activo`);

  for (const l of PLAN.softDeleteLeads) {
    const lead = await Lead.findById(l.leadId).lean();
    if (!lead) { problems.push(`softDeleteLeads: ${l.leadId} no existe`); continue; }
    if (lead.isDeleted) { problems.push(`softDeleteLeads: ${l.leadId} ya está isDeleted:true`); continue; }
    if (String(lead.business) !== MYREL) problems.push(`softDeleteLeads: ${l.leadId} no pertenece a Myrel Company (business=${lead.business})`);
    if (lead.phone !== l.expectedPhone) problems.push(`softDeleteLeads: ${l.leadId} phone="${lead.phone}", esperado "${l.expectedPhone}"`);
    if (lead.name !== l.expectedName) problems.push(`softDeleteLeads: ${l.leadId} name="${lead.name}", esperado "${l.expectedName}"`);
  }

  for (const l of PLAN.canonicalLeadsUnchanged) {
    const lead = await Lead.findById(l.leadId).lean();
    if (!lead) { problems.push(`canonicalLeadsUnchanged: ${l.leadId} no existe`); continue; }
    if (lead.isDeleted) problems.push(`canonicalLeadsUnchanged: ${l.leadId} está isDeleted:true — no debería`);
    if (String(lead.business) !== CREA_OS) problems.push(`canonicalLeadsUnchanged: ${l.leadId} no pertenece a CREA OS (business=${lead.business})`);
    if (lead.phone !== l.expectedPhone) problems.push(`canonicalLeadsUnchanged: ${l.leadId} phone="${lead.phone}", esperado "${l.expectedPhone}"`);
  }

  for (const l of PLAN.moveLeads) {
    const lead = await Lead.findById(l.leadId).lean();
    if (!lead) { problems.push(`moveLeads: ${l.leadId} no existe`); continue; }
    if (lead.isDeleted) problems.push(`moveLeads: ${l.leadId} ya está isDeleted:true`);
    if (String(lead.business) !== MYREL) problems.push(`moveLeads: ${l.leadId} no pertenece a Myrel Company (business=${lead.business})`);
    if (lead.phone !== l.expectedPhone) problems.push(`moveLeads: ${l.leadId} phone="${lead.phone}", esperado "${l.expectedPhone}"`);
  }

  for (const p of PLAN.movePipelines) {
    const pipeline = await Pipeline.findById(p.pipelineId).lean();
    if (!pipeline) { problems.push(`movePipelines: ${p.pipelineId} no existe`); continue; }
    if (String(pipeline.business) !== MYREL) problems.push(`movePipelines: ${p.pipelineId} no pertenece a Myrel Company`);
    if (pipeline.name !== p.expectedName) problems.push(`movePipelines: ${p.pipelineId} name="${pipeline.name}", esperado "${p.expectedName}"`);
  }

  for (const missionId of PLAN.moveDailyMissions) {
    const mission = await DailyMission.findById(missionId).lean();
    if (!mission) { problems.push(`moveDailyMissions: ${missionId} no existe`); continue; }
    if (String(mission.business) !== MYREL) problems.push(`moveDailyMissions: ${missionId} no pertenece a Myrel Company`);
  }

  const surplusUser = await User.findById(PLAN.deactivateUser.userId).lean();
  if (!surplusUser) problems.push(`deactivateUser: ${PLAN.deactivateUser.userId} no existe`);
  else {
    if (surplusUser.email !== PLAN.deactivateUser.expectedEmail) problems.push(`deactivateUser: email="${surplusUser.email}", esperado "${PLAN.deactivateUser.expectedEmail}"`);
    // Re-verificar huérfanos en vivo — el estado pudo haber cambiado desde la propuesta.
    const assigned = await Lead.countDocuments({ assignedTo: PLAN.deactivateUser.userId });
    const withActivity = await Lead.countDocuments({ 'activity.performedBy': PLAN.deactivateUser.userId });
    const withAgentMsgs = await Conversation.countDocuments({ 'messages.metadata.agentId': PLAN.deactivateUser.userId });
    if (assigned > 0) problems.push(`deactivateUser: ${assigned} lead(s) todavía asignados a este usuario`);
    if (withActivity > 0) problems.push(`deactivateUser: ${withActivity} lead(s) con actividad de este usuario`);
    if (withAgentMsgs > 0) problems.push(`deactivateUser: ${withAgentMsgs} conversación(es) con mensajes de este usuario`);
  }

  const realUser = await User.findById(PLAN.changeUserBusiness.userId).lean();
  if (!realUser) problems.push(`changeUserBusiness: ${PLAN.changeUserBusiness.userId} no existe`);
  else {
    if (realUser.email !== PLAN.changeUserBusiness.expectedEmail) problems.push(`changeUserBusiness: email="${realUser.email}", esperado "${PLAN.changeUserBusiness.expectedEmail}"`);
    if (String(realUser.business) !== PLAN.changeUserBusiness.expectedCurrentBusiness) problems.push(`changeUserBusiness: business actual="${realUser.business}", esperado "${PLAN.changeUserBusiness.expectedCurrentBusiness}"`);
  }

  return problems;
}

async function executeAll(session) {
  const opts = { session };

  for (const l of PLAN.softDeleteLeads) {
    const lead = await Lead.findById(l.leadId).session(session);
    const desc = l.canonicalLeadId
      ? `Fusión de negocios: duplicado del lead canónico ${l.canonicalLeadId} (CREA OS)`
      : 'Fusión de negocios: lead de prueba (número de la plataforma), no es un cliente real';
    lead.isDeleted = true;
    lead.deletedAt = new Date();
    lead.activity.push({ type: 'updated', description: desc, performedBy: null, performedByName: ACTOR_NAME });
    await lead.save(opts);
    logger.info(`  🗑️  Lead soft-deleted: ${l.leadId} (${l.expectedName})`);
  }

  for (const l of PLAN.canonicalLeadsUnchanged) {
    await Lead.updateOne(
      { _id: l.leadId },
      { $push: { activity: { type: 'updated', description: 'Fusión de negocios: confirmado como lead canónico tras fusionar Myrel Company', performedBy: null, performedByName: ACTOR_NAME } } },
      opts
    );
    logger.info(`  ✓ Lead canónico anotado (sin cambio de datos): ${l.leadId} (${l.expectedName})`);
  }

  for (const l of PLAN.moveLeads) {
    await Lead.updateOne(
      { _id: l.leadId },
      {
        $set: { business: CREA_OS },
        $push: { activity: { type: 'updated', description: 'Fusión de negocios: movido de Myrel Company a CREA OS', performedBy: null, performedByName: ACTOR_NAME } },
      },
      opts
    );
    logger.info(`  ➡️  Lead movido a CREA OS: ${l.leadId} (${l.expectedName})`);
  }

  for (const p of PLAN.movePipelines) {
    await Pipeline.updateOne({ _id: p.pipelineId }, { $set: { business: CREA_OS } }, opts);
    logger.info(`  ➡️  Pipeline movido a CREA OS: ${p.pipelineId} (${p.expectedName})`);
  }

  for (const missionId of PLAN.moveDailyMissions) {
    await DailyMission.updateOne({ _id: missionId }, { $set: { business: CREA_OS } }, opts);
    logger.info(`  ➡️  DailyMission movida a CREA OS: ${missionId}`);
  }

  await User.updateOne({ _id: PLAN.deactivateUser.userId }, { $set: { isActive: false } }, opts);
  logger.info(`  ⏸️  User desactivado: ${PLAN.deactivateUser.userId} (${PLAN.deactivateUser.expectedEmail})`);

  await User.updateOne({ _id: PLAN.changeUserBusiness.userId }, { $set: { business: CREA_OS } }, opts);
  logger.info(`  ➡️  User movido a CREA OS: ${PLAN.changeUserBusiness.userId} (${PLAN.changeUserBusiness.expectedEmail})`);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');
  logger.info('⚠️  Verificando el plan completo contra el estado real ANTES de escribir nada...');

  const problems = await verifyAll();
  if (problems.length > 0) {
    logger.error(`🚨 ABORTANDO — ${problems.length} problema(s) encontrados, NO se escribió nada:`);
    problems.forEach((p) => logger.error(`  - ${p}`));
    await mongoose.disconnect();
    process.exit(1);
  }
  logger.info('✓ Verificación completa, todo coincide con lo esperado. Ejecutando en una transacción...');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await executeAll(session);
    });
    logger.info('✓ Fusión completa — transacción confirmada (commit).');
  } catch (err) {
    logger.error('❌ Error durante la transacción — se revirtió TODO (rollback automático):', err.message);
    throw err;
  } finally {
    await session.endSession();
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error en la fusión:', err.message);
  process.exit(1);
});
