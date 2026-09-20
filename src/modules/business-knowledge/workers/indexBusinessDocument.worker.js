const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { procesarDocumento } = require('../pdfIngestion.service');
const logger = require('../../../utils/logger');

// Bloque 3 de la auditoría Business Brain (§45-50, 20/sep/2026) — RAG del
// PDF. Consume la cola que encola business.service.js#subirPdf() (vía
// indexBusinessDocument.queue.js) — todo el trabajo real (chunking,
// embeddings, cutover transaccional) vive en pdfIngestion.service.js, este
// archivo es solo el pegamento BullMQ, mismo criterio que
// automationExecute.worker.js.
async function processIndexJob(job) {
  const { documentId, textoCompleto } = job.data;
  const resultado = await procesarDocumento(documentId, textoCompleto);
  return { chunkCount: resultado.chunkCount };
}

function startIndexBusinessDocumentWorker() {
  const worker = new Worker(
    QUEUE_NAMES.INDEX_BUSINESS_DOCUMENT,
    async (job) => {
      try {
        return await processIndexJob(job);
      } catch (err) {
        logger.error('[indexBusinessDocumentWorker] error indexando documento', {
          jobId: job.id,
          documentId: job.data?.documentId,
          error: err.message,
        });
        throw err;
      }
    },
    // Concurrencia baja a propósito: cada job hace una llamada de embeddings
    // en batch a OpenAI (potencialmente varias decenas de chunks) — no hay
    // necesidad de paralelizar mucho, y evita saturar rate limits de la API
    // si varios negocios suben un PDF grande al mismo tiempo.
    { connection: getQueueConnection(), concurrency: 2 }
  );

  worker.on('failed', (job, err) => {
    logger.error('[indexBusinessDocumentWorker] job falló definitivamente (agotó reintentos)', {
      jobId: job?.id,
      documentId: job?.data?.documentId,
      error: err.message,
    });
    // Sin dead-letter propia a propósito: procesarDocumento() ya deja el
    // BusinessDocument en status:'failed' con el motivo — el estado
    // persistente ES el registro de fallo, no hace falta uno paralelo.
  });

  return worker;
}

module.exports = { startIndexBusinessDocumentWorker, processIndexJob };
