const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { AUTOMATION_SWEEP_INTERVAL_MS } = require('../../../config/env');
const logger = require('../../../utils/logger');

/**
 * Cola del barrido de triggers de tiempo (Caso 7 del backlog) — un único
 * job repetible, consumido por automationSweep.worker.js. Cada tick
 * pregunta "qué leads cumplen una condición de tiempo ahora" y encola un
 * job en AUTOMATION_EXECUTE por cada (automatización, lead) que corresponde
 * — no ejecuta nada acá directamente (ver automationExecute.queue.js).
 */

let queue = null;
function getAutomationSweepQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.AUTOMATION_SWEEP, { connection: getQueueConnection() });
  return queue;
}

/**
 * Registra el job repetible del barrido — idempotente: usa
 * upsertJobScheduler() (BullMQ 6+), que actualiza el scheduler existente
 * en vez de crear uno duplicado si se llama más de una vez con el mismo
 * `jobSchedulerId` (ej. en cada boot del worker, o en un rolling restart
 * con varias instancias arrancando casi al mismo tiempo). A diferencia de
 * la opción `repeat` clásica de `.add()` (deprecada, con un bug conocido de
 * duplicados en versiones viejas de BullMQ), esta API es la recomendada
 * para jobs repetibles desde BullMQ 5+.
 *
 * Se llama una vez al boot del worker (ver worker.js) — nunca desde el
 * proceso de la API.
 */
async function scheduleAutomationSweep() {
  const q = getAutomationSweepQueue();
  await q.upsertJobScheduler(
    'automation-sweep-scheduler',
    { every: AUTOMATION_SWEEP_INTERVAL_MS },
    { name: 'sweep' }
  );
  logger.info(`[automationSweepQueue] job repetible registrado (cada ${AUTOMATION_SWEEP_INTERVAL_MS}ms)`);
}

module.exports = { getAutomationSweepQueue, scheduleAutomationSweep };
