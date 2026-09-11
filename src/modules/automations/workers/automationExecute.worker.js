const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const Automation = require('../automation.model');
const Lead = require('../../leads/lead.model');
const { runAutomation } = require('../automation.engine');
const { conditionStillTrue } = require('../timeTriggers.registry');
// Mismo patrón que execSendNotification() (automation.engine.js) y
// updateLeadStage() (ai/tools/index.js) — referencia viva al módulo
// completo, no destructurada.
const notificationService = require('../../admin/notification.service');
const pushService = require('../../push/push.service');
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
  const resultado = await runAutomation(automation, lead, { triggerType, sweep: true });

  // Guardrail de visibilidad para "Cierre automático" (Caso 5 del
  // backlog): change_stage se auto-ejecuta sin supervisión humana cuando
  // stage_stalled se cumple (decisión de producto explícita — el mecanismo
  // de riesgo es el mismo que ya se documentó al comparar con "Nivel", se
  // procede igual). Esto no bloquea ni condiciona la ejecución en
  // absoluto: solo avisa al vendedor asignado DESPUÉS de que ya pasó, para
  // que se entere al toque de que un lead se movió solo.
  if (triggerType === 'stage_stalled') {
    await notificarCambioDeEtapaAutomatico(automation, lead, resultado);
  }

  return { executed: true };
}

/**
 * Busca, dentro de ESTA ejecución puntual, si la acción change_stage
 * realmente tuvo éxito (no alcanza con mirar el status general de la
 * automatización: si en el futuro una automatización de stage_stalled
 * tuviera más de una acción, una acción distinta fallando no debería
 * suprimir este aviso, ni una change_stage fallida debería disparar un
 * aviso de "se movió" cuando en realidad no se movió).
 *
 * Fail-soft, mismo criterio que el resto de los 3 disparadores de
 * notificación ya existentes (PR-C/D/E, execSendNotification(),
 * updateLeadStage()): un fallo acá nunca debe tumbar el job — la etapa ya
 * cambió y ya se guardó, avisar es un beneficio adicional, no un
 * requisito para que la automatización se considere exitosa.
 */
async function notificarCambioDeEtapaAutomatico(automation, lead, resultado) {
  const cambioDeEtapa = resultado?.actionsExecuted?.find(
    (a) => a.type === 'change_stage' && a.status === 'success'
  );
  if (!cambioDeEtapa || !lead.assignedTo) return;

  const etapaNueva = cambioDeEtapa.result?.to;

  try {
    await notificationService.createNotification({
      business: automation.business,
      user: lead.assignedTo,
      type: 'info',
      category: 'automation',
      title: `${lead.name} avanzó de etapa automáticamente`,
      message: `"${automation.name}" movió a ${lead.name} a la etapa "${etapaNueva}" sin intervención humana.`,
      meta: {
        leadId: lead._id,
        automationId: automation._id,
        event: 'stage_stalled_auto_change',
        to: etapaNueva,
      },
    });
  } catch (error) {
    logger.error(`[automationExecuteWorker] createNotification() falló (no afecta el cambio de etapa ya guardado): ${error.message}`);
  }

  try {
    await pushService.sendToUser(lead.assignedTo, {
      title: `${lead.name} avanzó de etapa automáticamente`,
      body: `Ahora en "${etapaNueva}" — movido por "${automation.name}", sin intervención humana`,
      data: { type: 'stage_stalled_auto_change', leadId: String(lead._id), automationId: String(automation._id) },
    });
  } catch (error) {
    logger.error(`[automationExecuteWorker] sendToUser() falló (no afecta el cambio de etapa ya guardado): ${error.message}`);
  }
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
