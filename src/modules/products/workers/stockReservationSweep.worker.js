const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { liberarReservasVencidas } = require('../productInventory.service');
const logger = require('../../../utils/logger');

/**
 * Barrido de reservas de stock vencidas (Bloque 4, §59, 20/sep/2026) —
 * corre en el job repetible registrado por
 * stockReservationSweep.queue.js#scheduleStockReservationSweep(). Mismo
 * patrón EXACTO que automationSweep.worker.js: el job solo dispara
 * liberarReservasVencidas() (productInventory.service.js), que ya trae su
 * propio manejo fail-soft por reserva puntual.
 */
function startStockReservationSweepWorker() {
  const worker = new Worker(
    QUEUE_NAMES.STOCK_RESERVATION_SWEEP,
    async (job) => {
      try {
        return await liberarReservasVencidas();
      } catch (err) {
        logger.error('[stockReservationSweepWorker] error procesando el barrido', {
          jobId: job.id,
          error: err.message,
          stack: err.stack,
        });
        throw err;
      }
    },
    // concurrency:1 — mismo motivo que automationSweep.worker.js: nunca dos
    // barridos en simultáneo, el próximo tick del job repetible llega solo.
    { connection: getQueueConnection(), concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error('[stockReservationSweepWorker] job de barrido falló', { jobId: job?.id, error: err.message });
    // Sin dead-letter acá a propósito, mismo criterio que
    // automationSweep.worker.js: el próximo tick programado vuelve a
    // intentar el barrido completo de cero.
  });

  return worker;
}

module.exports = { startStockReservationSweepWorker };
