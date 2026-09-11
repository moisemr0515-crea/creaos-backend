const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { AUTOMATION_COOLDOWN_HOURS } = require('../../../config/env');
const Automation = require('../automation.model');
const AutomationLog = require('../automation-log.model');
const Lead = require('../../leads/lead.model');
const { TIME_TRIGGER_TYPES, buildLeadCandidateFilterForAutomation } = require('../timeTriggers.registry');
const { enqueueAutomationExecution } = require('../queues/automationExecute.queue');
const logger = require('../../../utils/logger');

const HOUR_MS = 60 * 60 * 1000;

/**
 * Barrido de triggers de tiempo (Caso 7 del backlog) — corre en el job
 * repetible registrado por automationSweep.queue.js#scheduleAutomationSweep().
 * NO ejecuta ninguna automatización acá: solo encuentra qué pares
 * (automatización, lead) corresponden y los encola en AUTOMATION_EXECUTE
 * (automationExecute.worker.js hace el recheck + la ejecución real). Mismo
 * criterio que separa Gateway de Worker en whatsapp-inbound/outbound: la
 * parte "encontrar qué hay que hacer" no debería bloquearse ni fallar junto
 * con la parte "hacerlo".
 *
 * Por cada trigger de tiempo (TIME_TRIGGER_TYPES — hoy lead_stale y
 * stage_stalled), por cada automatización activa de ese tipo (en TODOS los
 * negocios — usa el índice global de automation.model.js), arma el filtro
 * de Mongo vía timeTriggers.registry.js y busca los leads candidatos DE ESE
 * NEGOCIO (usa los índices {business,isDeleted,lastContactedAt/
 * stageChangedAt} de lead.model.js). Antes de encolar cada candidato,
 * chequea el cooldown contra AutomationLog en una sola query por
 * automatización (no una por lead) — así una condición que sigue siendo
 * cierta ciclo tras ciclo no re-encola al mismo lead cada 15 minutos.
 */
async function processSweepJob() {
  let totalCandidatos = 0;
  let totalEncolados = 0;
  const cooldownCutoff = new Date(Date.now() - AUTOMATION_COOLDOWN_HOURS * HOUR_MS);

  for (const triggerType of TIME_TRIGGER_TYPES) {
    // Sin filtro de `business` — a propósito, este es el barrido global
    // (ver el índice {'trigger.type', isActive, isDeleted} sin prefijo de
    // business que agregó el PR 1 específicamente para esta query).
    const automations = await Automation.find({
      'trigger.type': triggerType,
      isActive: true,
      isDeleted: false,
    });

    for (const automation of automations) {
      let filtroTiempo;
      try {
        filtroTiempo = buildLeadCandidateFilterForAutomation(automation);
      } catch (err) {
        // Una automatización mal configurada (ej. sin la condición
        // daysThreshold, o con un valor inválido) no debe tumbar el resto
        // del barrido — se salta y se loguea, mismo criterio fail-soft que
        // el resto del motor de automatizaciones.
        logger.error(
          `[automationSweepWorker] automatización ${automation._id} (${triggerType}) mal configurada, se salta: ${err.message}`
        );
        continue;
      }

      const leads = await Lead.find({
        business: automation.business,
        isDeleted: false,
        ...filtroTiempo,
      }).select('_id').lean();

      if (!leads.length) continue;
      totalCandidatos += leads.length;

      // Cooldown en una sola query por automatización (no una por lead) —
      // usa el índice {automation, lead, startedAt} del PR 1.
      const leadIds = leads.map((l) => l._id);
      const idsEnCooldown = await AutomationLog.find({
        automation: automation._id,
        lead: { $in: leadIds },
        startedAt: { $gte: cooldownCutoff },
      }).distinct('lead');
      const enCooldown = new Set(idsEnCooldown.map((id) => id.toString()));

      for (const lead of leads) {
        if (enCooldown.has(lead._id.toString())) continue;
        await enqueueAutomationExecution({ automationId: automation._id, leadId: lead._id, triggerType });
        totalEncolados++;
      }
    }
  }

  logger.info(
    `[automationSweepWorker] barrido completo: ${totalCandidatos} candidatos, ${totalEncolados} encolados (cooldown ${AUTOMATION_COOLDOWN_HOURS}h)`
  );
  return { totalCandidatos, totalEncolados };
}

function startAutomationSweepWorker() {
  const worker = new Worker(
    QUEUE_NAMES.AUTOMATION_SWEEP,
    async (job) => {
      try {
        return await processSweepJob();
      } catch (err) {
        logger.error('[automationSweepWorker] error procesando el barrido', {
          jobId: job.id,
          error: err.message,
          stack: err.stack,
        });
        throw err;
      }
    },
    // concurrency:1 — nunca dos barridos corriendo en simultáneo (no habría
    // ganancia real, y complicaría el razonamiento sobre duplicados). El
    // próximo tick del job repetible llega solo, pase lo que pase con éste.
    { connection: getQueueConnection(), concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error('[automationSweepWorker] job de barrido falló', { jobId: job?.id, error: err.message });
    // Sin dead-letter acá a propósito: un barrido fallido no tiene datos
    // puntuales que perder (no es un mensaje de un lead específico) — el
    // próximo tick programado del repeatable job vuelve a intentar el
    // barrido completo de cero.
  });

  return worker;
}

module.exports = { startAutomationSweepWorker, processSweepJob };
