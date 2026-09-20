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
const { checkWorkerHealth } = require('./src/health/workerHealth.service');
const { recoverPendingOutboundEvents } = require('./src/modules/channels/queues/outbound.queue');
const { startInboundWorker } = require('./src/modules/channels/workers/inbound.worker');
const { startOutboundWorker } = require('./src/modules/channels/workers/outbound.worker');
// Caso 7 del backlog — motor de automatizaciones, trigger por tiempo.
const { scheduleAutomationSweep } = require('./src/modules/automations/queues/automationSweep.queue');
const { startAutomationSweepWorker } = require('./src/modules/automations/workers/automationSweep.worker');
const { startAutomationExecuteWorker } = require('./src/modules/automations/workers/automationExecute.worker');
// Bloque 3 de la auditoría Business Brain (§45-50, 20/sep/2026) — RAG del PDF.
const { startIndexBusinessDocumentWorker } = require('./src/modules/business-knowledge/workers/indexBusinessDocument.worker');

// Puerto propio, distinto del de la API — Railway lo usa solo para su
// healthcheck de este servicio, no queda expuesto públicamente salvo que se
// habilite networking explícito para este servicio (decisión de infra,
// fuera de este archivo).
const WORKER_PORT = process.env.WORKER_PORT || PORT;

let inboundWorker;
let outboundWorker;
let automationSweepWorker;
let automationExecuteWorker;
let indexBusinessDocumentWorker;
let httpServer;

const iniciar = async () => {
  try {
    await Promise.all([connectMongoDB(), connectRedis()]);
    getQueueConnection(); // fuerza la conexión dedicada de BullMQ a inicializarse temprano

    inboundWorker = startInboundWorker();
    outboundWorker = startOutboundWorker();
    automationSweepWorker = startAutomationSweepWorker();
    automationExecuteWorker = startAutomationExecuteWorker();
    indexBusinessDocumentWorker = startIndexBusinessDocumentWorker();
    await recoverPendingOutboundEvents();
    // Idempotente (upsertJobScheduler) — seguro de llamar en cada boot,
    // incluso con varias instancias de este worker arrancando a la vez
    // (rolling restart de Railway).
    await scheduleAutomationSweep();

    httpServer = http.createServer(async (req, res) => {
      if (req.url === '/health/live') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/health' || req.url === '/health/ready') {
        try {
          const health = await checkWorkerHealth({ workers: {
            inbound: inboundWorker,
            outbound: outboundWorker,
            automationSweep: automationSweepWorker,
            automationExecute: automationExecuteWorker,
            indexBusinessDocument: indexBusinessDocumentWorker,
          } });
          res.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: health.ok ? 'ok' : 'degraded',
            dependencies: health.dependencies,
            queues: health.queues,
            workers: health.workers,
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
║            ${QUEUE_NAMES.AUTOMATION_SWEEP}, ${QUEUE_NAMES.AUTOMATION_EXECUTE},
║            ${QUEUE_NAMES.INDEX_BUSINESS_DOCUMENT}
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
    if (indexBusinessDocumentWorker) await indexBusinessDocumentWorker.close();
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
