// Entrypoint del servicio Railway independiente `creaos-backend-worker`
// (Blueprint §4.6, Decisión 2). NO levanta Express ni sirve tráfico HTTP
// público — solo conecta a Mongo/Redis y corre los Worker de BullMQ. El
// servidor HTTP mínimo de acá abajo es exclusivamente para el healthcheck
// interno de Railway.

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const http = require('http');
const { validateEnv, PORT } = require('./src/config/env');

// El worker no sirve webhooks. Valida solo su configuración base; la API es
// quien valida al arrancar los secretos de integraciones HTTP configuradas.
validateEnv({ runtime: 'worker', validateWebhookIntegrations: false });

const logger = require('./src/utils/logger');
const { connectMongoDB, disconnectMongoDB } = require('./src/config/database');
const { connectRedis, disconnectRedis } = require('./src/config/redis');
const { getQueueConnection, disconnectQueueConnection, QUEUE_NAMES } = require('./src/config/queue');
const { checkCoreHealth } = require('./src/health/health.service');
const { getInboundQueue } = require('./src/modules/channels/queues/inbound.queue');
const { getOutboundQueue, recoverPendingOutboundEvents } = require('./src/modules/channels/queues/outbound.queue');
const { startInboundWorker } = require('./src/modules/channels/workers/inbound.worker');
const { startOutboundWorker } = require('./src/modules/channels/workers/outbound.worker');
// Caso 7 del backlog — motor de automatizaciones, trigger por tiempo.
const { getAutomationSweepQueue, scheduleAutomationSweep } = require('./src/modules/automations/queues/automationSweep.queue');
const { getAutomationExecuteQueue } = require('./src/modules/automations/queues/automationExecute.queue');
const { startAutomationSweepWorker } = require('./src/modules/automations/workers/automationSweep.worker');
const { startAutomationExecuteWorker } = require('./src/modules/automations/workers/automationExecute.worker');

// Puerto propio, distinto del de la API — Railway lo usa solo para su
// healthcheck de este servicio, no queda expuesto públicamente salvo que se
// habilite networking explícito para este servicio (decisión de infra,
// fuera de este archivo).
const WORKER_PORT = process.env.WORKER_PORT || PORT;

let inboundWorker;
let outboundWorker;
let automationSweepWorker;
let automationExecuteWorker;
let httpServer;

const iniciar = async () => {
  try {
    await Promise.all([connectMongoDB(), connectRedis()]);
    getQueueConnection(); // fuerza la conexión dedicada de BullMQ a inicializarse temprano

    inboundWorker = startInboundWorker();
    outboundWorker = startOutboundWorker();
    automationSweepWorker = startAutomationSweepWorker();
    automationExecuteWorker = startAutomationExecuteWorker();
    await recoverPendingOutboundEvents();
    // Idempotente (upsertJobScheduler) — seguro de llamar en cada boot,
    // incluso con varias instancias de este worker arrancando a la vez
    // (rolling restart de Railway).
    await scheduleAutomationSweep();

    httpServer = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        try {
          const [coreHealth, inboundCounts, outboundCounts, sweepCounts, executeCounts] = await Promise.all([
            checkCoreHealth(),
            getInboundQueue().getJobCounts(),
            getOutboundQueue().getJobCounts(),
            getAutomationSweepQueue().getJobCounts(),
            getAutomationExecuteQueue().getJobCounts(),
          ]);
          res.writeHead(coreHealth.ok ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: coreHealth.ok ? 'ok' : 'degraded',
            dependencies: coreHealth.dependencies,
            queues: {
              [QUEUE_NAMES.INBOUND]: inboundCounts,
              [QUEUE_NAMES.OUTBOUND]: outboundCounts,
              [QUEUE_NAMES.AUTOMATION_SWEEP]: sweepCounts,
              [QUEUE_NAMES.AUTOMATION_EXECUTE]: executeCounts,
            },
          }));
        } catch (err) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'degraded' }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });

    httpServer.listen(WORKER_PORT, () => {
      logger.info(`
╔════════════════════════════════════════╗
║       CREA OS Backend — Worker          ║
╠════════════════════════════════════════╣
║  Puerto  : ${WORKER_PORT}
║  Entorno : ${process.env.NODE_ENV}
║  Colas   : ${QUEUE_NAMES.INBOUND}, ${QUEUE_NAMES.OUTBOUND}, ${QUEUE_NAMES.DEAD_LETTER},
║            ${QUEUE_NAMES.AUTOMATION_SWEEP}, ${QUEUE_NAMES.AUTOMATION_EXECUTE}
╚════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    logger.error('❌ Error fatal al iniciar el worker:', error);
    process.exit(1);
  }
};

const apagar = async (señal) => {
  logger.info(`\n${señal} recibido. Cerrando worker limpiamente...`);
  try {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    if (inboundWorker) await inboundWorker.close();
    if (outboundWorker) await outboundWorker.close();
    if (automationSweepWorker) await automationSweepWorker.close();
    if (automationExecuteWorker) await automationExecuteWorker.close();
    await disconnectQueueConnection();
    await disconnectRedis();
    await disconnectMongoDB();
    logger.info('Worker cerrado limpiamente');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error cerrando el worker:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));

iniciar();
