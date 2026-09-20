const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } = require('../../../config/queue');

// Bloque 3 de la auditoría Business Brain (§45-50, 20/sep/2026) — RAG del
// PDF. Un job por cada BusinessDocument nuevo (business.service.js#subirPdf()
// ya creó el registro vía pdfIngestion.service.js#iniciarNuevoDocumento()
// de forma síncrona, antes de encolar acá) — el worker
// (indexBusinessDocument.worker.js) hace el trabajo pesado (embeddings +
// cutover transaccional) fuera del request HTTP.

let queue = null;
function getIndexBusinessDocumentQueue() {
  if (!queue) queue = new Queue(QUEUE_NAMES.INDEX_BUSINESS_DOCUMENT, { connection: getQueueConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
  return queue;
}

/**
 * `jobId` = el propio documentId — determinístico, mismo motivo que
 * automationExecute.queue.js: un reintento de subida (o un doble-click en
 * el dashboard antes de que el POST anterior vuelva) que de alguna forma
 * reencolara el MISMO documentId no crea un job duplicado.
 * @param {{documentId: string, textoCompleto: string}} params
 */
async function enqueueIndexBusinessDocument({ documentId, textoCompleto }) {
  return getIndexBusinessDocumentQueue().add(
    'index-business-document',
    { documentId: String(documentId), textoCompleto },
    { jobId: String(documentId) }
  );
}

module.exports = { getIndexBusinessDocumentQueue, enqueueIndexBusinessDocument };
