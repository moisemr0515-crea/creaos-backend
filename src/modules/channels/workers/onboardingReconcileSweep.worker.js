const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { ONBOARDING_RECONCILE_ENABLED } = require('../../../config/env');
const { sweepPendingOnboardingSessions } = require('../channelOnboardingReconcileSweep.service');
const logger = require('../../../utils/logger');

/**
 * Barrido automático de conciliación del onboarding de WhatsApp (incidente de
 * Nutriva, 14/oct/2026) — corre en el job repetible registrado por
 * onboardingReconcileSweep.queue.js#scheduleOnboardingReconcileSweep(). Mismo
 * patrón EXACTO que automationSweep.worker.js / stockReservationSweep.worker.js:
 * el job solo dispara el servicio, que ya trae su propio manejo por sesión.
 */
async function processOnboardingReconcileSweepJob(job) {
  // Interruptor de emergencia: un job ya programado en Redis no hace nada si se apagó.
  if (!ONBOARDING_RECONCILE_ENABLED) return { omitido: true };

  try {
    return await sweepPendingOnboardingSessions();
  } catch (err) {
    logger.error('[onboardingReconcileSweepWorker] error procesando el barrido', {
      jobId: job?.id,
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

function startOnboardingReconcileSweepWorker() {
  const worker = new Worker(
    QUEUE_NAMES.ONBOARDING_RECONCILE_SWEEP,
    processOnboardingReconcileSweepJob,
    // concurrency:1 — nunca dos barridos en la misma instancia; entre instancias
    // (rolling restart) lo garantiza el arrendamiento por sesión del servicio.
    { connection: getQueueConnection(), concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error('[onboardingReconcileSweepWorker] job de barrido falló', { jobId: job?.id, error: err.message });
    // Sin dead-letter a propósito (igual que los otros barridos): el próximo tick
    // vuelve a intentar desde el estado persistido en cada sesión.
  });

  return worker;
}

module.exports = { startOnboardingReconcileSweepWorker, processOnboardingReconcileSweepJob };
