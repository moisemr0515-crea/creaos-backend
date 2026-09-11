const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const Automation = require('../automation.model');
const Lead = require('../../leads/lead.model');
const { runAutomation } = require('../automation.engine');
const { conditionStillTrue } = require('../timeTriggers.registry');
const logger = require('../../../utils/logger');

/**
 * Ejecuta UNA automatización de tiempo sobre UN lead — el job que encola
 * automationSweep.worker.js por cada par (automatización, lead) candidato.
 *
 * Reusa runAutomation() de automation.engine.js sin ningún cambio — mismo
 * motor que ya usan los 6 triggers de evento. Lo único nuevo acá es el
 * recheck previo (conditionStillTrue(), timeTriggers.registry.js): el
 * barrido pudo haber encontrado a este lead como candidato varios minutos
 * antes de que este job corra de verdad (backlog de la cola); si en el
 * medio alguien lo contactó (o cambió de etapa), ya no corresponde
 * ejecutar la automatización.
 */
async function processExecuteJob(job) {
  const { automationId, leadId, triggerType } = job.data;

  const automation = await Automation.findOne({ _id: automationId, isActive: true, isDeleted: false });
  if (!automation) {
    logger.info('[automationExecuteWorker] automatización ya no está activa (se desactivó/borró desde el barrido), se salta', {
      automationId,
    });
    return { skipped: true, reason: 'automation_not_active' };
  }

  const lead = await Lead.findOne({ _id: leadId, business: automation.business, isDeleted: false });
  if (!lead) {
    logger.info('[automationExecuteWorker] lead ya no existe/fue borrado, se salta', { leadId, automationId });
    return { skipped: true, reason: 'lead_not_found' };
  }

  if (!conditionStillTrue(automation, lead)) {
    logger.info('[automationExecuteWorker] la condición ya no es cierta (recheck), se salta la ejecución', {
      automationId,
      leadId,
      triggerType,
    });
    return { skipped: true, reason: 'condition_no_longer_true' };
  }

  // runAutomation() nunca lanza por un fallo de acción individual (marca
  // overallStatus:'partial' en su propio AutomationLog) — no hace falta
  // try/catch acá para eso. Un throw real acá solo puede venir de un error
  // de infraestructura (Mongo caído, etc.), y eso SÍ debe hacer fallar el
  // job de BullMQ para que se reintente (DEFAULT_JOB_OPTIONS).
  await runAutomation(automation, lead, { triggerType, sweep: true });
  return { executed: true };
}

function startAutomationExecuteWorker() {
  const worker = new Worker(
    QUEUE_NAMES.AUTOMATION_EXECUTE,
    async (job) => {
      try {
        return await processExecuteJob(job);
      } catch (err) {
        logger.error('[automationExecuteWorker] error ejecutando job', {
          jobId: job.id,
          error: err.message,
          stack: err.stack,
        });
        throw err;
      }
    },
    // Mismo valor que inbound/outbound worker — no hay motivo para que este
    // dominio necesite una concurrencia distinta.
    { connection: getQueueConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    logger.error('[automationExecuteWorker] job de ejecución falló', { jobId: job?.id, error: err.message });
    // Sin dead-letter a propósito: runAutomation() ya deja su propio
    // AutomationLog con status 'failed'/'partial' por cada intento — un
    // segundo registro paralelo en dead-letter sería redundante. Los
    // reintentos automáticos de BullMQ (DEFAULT_JOB_OPTIONS, 3 intentos)
    // ya cubren fallos transitorios de infraestructura.
  });

  return worker;
}

module.exports = { startAutomationExecuteWorker, processExecuteJob };
