const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { STOCK_RESERVATION_SWEEP_INTERVAL_MS } = require('../../../config/env');
const logger = require('../../../utils/logger');

/**
 * Cola del barrido de reservas de stock vencidas (Bloque 4, §59,
 * 20/sep/2026) — un único job repetible, consumido por
 * stockReservationSweep.worker.js. Mismo patrón EXACTO que
 * automationSweep.queue.js (Caso 7): cada tick libera el stock apartado por
 * toda reserva `active` cuyo `expiresAt` ya pasó.
 */

let queue = null;
function getStockReservationSweepQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.STOCK_RESERVATION_SWEEP, { connection: getQueueConnection() });
  return queue;
}

/**
 * Registra el job repetible del barrido — idempotente vía
 * upsertJobScheduler() (BullMQ 6+), mismo motivo que
 * scheduleAutomationSweep(): seguro de llamar en cada boot del worker,
 * incluso con varias instancias arrancando casi al mismo tiempo (rolling
 * restart de Railway). Se llama una vez al boot del worker (ver worker.js).
 */
async function scheduleStockReservationSweep() {
  const q = getStockReservationSweepQueue();
  await q.upsertJobScheduler(
    'stock-reservation-sweep-scheduler',
    { every: STOCK_RESERVATION_SWEEP_INTERVAL_MS },
    { name: 'sweep' }
  );
  logger.info(`[stockReservationSweepQueue] job repetible registrado (cada ${STOCK_RESERVATION_SWEEP_INTERVAL_MS}ms)`);
}

module.exports = { getStockReservationSweepQueue, scheduleStockReservationSweep };
