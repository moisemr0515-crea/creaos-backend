const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const {
  ONBOARDING_RECONCILE_ENABLED,
  ONBOARDING_RECONCILE_INTERVAL_MS,
  GUPSHUP_PARTNER_EMAIL,
  GUPSHUP_PARTNER_SECRET,
} = require('../../../config/env');
const logger = require('../../../utils/logger');

/**
 * Cola del barrido automático de conciliación del onboarding de WhatsApp
 * (incidente de Nutriva, 14/oct/2026) — un único job repetible, consumido por
 * onboardingReconcileSweep.worker.js. Mismo patrón EXACTO que
 * automationSweep.queue.js y stockReservationSweep.queue.js: vive en el worker
 * existente, no es un servicio nuevo.
 */

let queue = null;
function getOnboardingReconcileSweepQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.ONBOARDING_RECONCILE_SWEEP, { connection: getQueueConnection() });
  return queue;
}

/**
 * Registra el job repetible — idempotente vía upsertJobScheduler() (BullMQ 6+),
 * seguro de llamar en cada boot del worker aunque arranquen varias instancias a
 * la vez (rolling restart de Railway). Se llama una vez al boot del worker
 * (ver worker.js) — nunca desde el proceso de la API.
 *
 * Con ONBOARDING_RECONCILE_ENABLED=false no registra nada nuevo (y el worker
 * ignora cualquier job que ya estuviera programado, ver el worker).
 */
async function scheduleOnboardingReconcileSweep() {
  if (!ONBOARDING_RECONCILE_ENABLED) {
    logger.warn('[onboardingReconcileSweepQueue] ONBOARDING_RECONCILE_ENABLED=false — el barrido de conciliación NO se programa');
    return;
  }

  // partner.auth.js#getValidToken() usa el token cacheado en Redis (TTL 23h) y,
  // si no hay, hace login con estas credenciales. Sin ellas en ESTE servicio, el
  // barrido solo funciona mientras la API haya dejado un token vigente en el
  // cache — se avisa fuerte al arrancar para que no sea una sorpresa en producción.
  if (!GUPSHUP_PARTNER_EMAIL || !GUPSHUP_PARTNER_SECRET) {
    logger.warn(
      '[onboardingReconcileSweepQueue] GUPSHUP_PARTNER_EMAIL/GUPSHUP_PARTNER_SECRET no están configuradas en este servicio: ' +
      'el barrido de conciliación solo podrá autenticarse mientras haya un token de partner cacheado en Redis (TTL 23h)'
    );
  }

  const q = getOnboardingReconcileSweepQueue();
  await q.upsertJobScheduler(
    'onboarding-reconcile-sweep-scheduler',
    { every: ONBOARDING_RECONCILE_INTERVAL_MS },
    { name: 'sweep' }
  );
  logger.info(`[onboardingReconcileSweepQueue] job repetible registrado (cada ${ONBOARDING_RECONCILE_INTERVAL_MS}ms)`);
}

module.exports = { getOnboardingReconcileSweepQueue, scheduleOnboardingReconcileSweep };
