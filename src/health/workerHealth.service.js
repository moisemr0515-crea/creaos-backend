const { HEALTH_TIMEOUT_MS, checkCoreHealth, withTimeout } = require('./health.service');
const { QUEUE_NAMES } = require('../config/queue');
const { getInboundQueue } = require('../modules/channels/queues/inbound.queue');
const { getOutboundQueue } = require('../modules/channels/queues/outbound.queue');
const { getDeadLetterQueue } = require('../modules/channels/queues/deadLetter.queue');
const { getAutomationSweepQueue } = require('../modules/automations/queues/automationSweep.queue');
const { getAutomationExecuteQueue } = require('../modules/automations/queues/automationExecute.queue');
const { getIndexBusinessDocumentQueue } = require('../modules/business-knowledge/queues/indexBusinessDocument.queue');
const { getStockReservationSweepQueue } = require('../modules/products/queues/stockReservationSweep.queue');

const DEFAULT_QUEUE_PROVIDERS = {
  [QUEUE_NAMES.INBOUND]: getInboundQueue,
  [QUEUE_NAMES.OUTBOUND]: getOutboundQueue,
  [QUEUE_NAMES.DEAD_LETTER]: getDeadLetterQueue,
  [QUEUE_NAMES.AUTOMATION_SWEEP]: getAutomationSweepQueue,
  [QUEUE_NAMES.AUTOMATION_EXECUTE]: getAutomationExecuteQueue,
  [QUEUE_NAMES.INDEX_BUSINESS_DOCUMENT]: getIndexBusinessDocumentQueue,
  [QUEUE_NAMES.STOCK_RESERVATION_SWEEP]: getStockReservationSweepQueue,
};

async function checkWorkerHealth({
  coreHealthProvider = checkCoreHealth,
  queueProviders = DEFAULT_QUEUE_PROVIDERS,
  workers = {},
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const coreHealth = await coreHealthProvider();
  const queueEntries = await Promise.all(Object.entries(queueProviders).map(async ([name, provider]) => {
    try {
      const counts = await withTimeout(provider().getJobCounts(), timeoutMs);
      return [name, { status: 'up', counts }];
    } catch {
      return [name, { status: 'down' }];
    }
  }));

  const queues = Object.fromEntries(queueEntries);
  const workerStates = Object.fromEntries(Object.entries(workers).map(([name, worker]) => [
    name,
    worker?.isRunning?.() === true ? 'up' : 'down',
  ]));
  const queuesUp = Object.values(queues).every(({ status }) => status === 'up');
  const workersUp = Object.keys(workerStates).length > 0
    && Object.values(workerStates).every((status) => status === 'up');

  return {
    ok: coreHealth.ok && queuesUp && workersUp,
    dependencies: coreHealth.dependencies,
    queues,
    workers: workerStates,
  };
}

module.exports = { DEFAULT_QUEUE_PROVIDERS, checkWorkerHealth };
