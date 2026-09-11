const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } = require('../../../config/queue');

/**
 * Cola de ejecución de automatizaciones de tiempo — un job por cada par
 * (automatización, lead) que el barrido (automationSweep.worker.js)
 * encontró candidato. Consumida por automationExecute.worker.js, que
 * rechequea la condición antes de correr runAutomation() (ver ese archivo
 * para el porqué del recheck).
 */

let queue = null;
function getAutomationExecuteQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.AUTOMATION_EXECUTE, { connection: getQueueConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return queue;
}

/**
 * `jobId` determinístico (`${automationId}:${leadId}`), a propósito: BullMQ
 * ignora un `add()` con un `jobId` que ya existe en estado waiting/active
 * (devuelve el job existente en vez de crear uno nuevo) — si el barrido
 * intentara encolar el mismo par dos veces en el mismo ciclo (por ejemplo,
 * si el filtro de Mongo matchea el mismo lead más de una vez por alguna
 * razón), esto lo dedupea solo, sin lógica extra. Una vez que el job
 * completa y se limpia (removeOnComplete de DEFAULT_JOB_OPTIONS), el mismo
 * `jobId` queda libre para un ciclo futuro — el cooldown real lo sigue
 * decidiendo el chequeo contra AutomationLog en el sweep, esto es solo una
 * protección adicional contra duplicados dentro del mismo ciclo.
 *
 * @param {{automationId: string, leadId: string, triggerType: string}} params
 */
async function enqueueAutomationExecution({ automationId, leadId, triggerType }) {
  return getAutomationExecuteQueue().add(
    'execute-time-trigger',
    { automationId: String(automationId), leadId: String(leadId), triggerType },
    { jobId: `${automationId}:${leadId}` }
  );
}

module.exports = { getAutomationExecuteQueue, enqueueAutomationExecution };
