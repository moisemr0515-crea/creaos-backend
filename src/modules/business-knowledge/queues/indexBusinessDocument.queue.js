const { Queue } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } = require('../../../config/queue');
const BusinessDocument = require('../businessDocument.model');
const BusinessDocumentChunk = require('../businessDocumentChunk.model');
const logger = require('../../../utils/logger');

const RECOVERABLE_STATUSES = ['uploaded', 'enqueue_failed', 'queued'];
const DEFAULT_STALE_MS = 15 * 60 * 1000;

let queue = null;
function getIndexBusinessDocumentQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAMES.INDEX_BUSINESS_DOCUMENT, {
      connection: getQueueConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return queue;
}

/**
 * El job solo lleva documentId. El texto vive en BusinessDocument para que
 * una caída de Redis no destruya la intención de indexación.
 */
async function enqueueIndexBusinessDocument({ documentId }) {
  const jobId = String(documentId);
  const document = await BusinessDocument.findById(documentId).select('_id business version status');
  if (!document) throw new Error(`BusinessDocument ${documentId} no encontrado`);
  if (!RECOVERABLE_STATUSES.includes(document.status)) return null;

  try {
    const outboundQueue = getIndexBusinessDocumentQueue();
    const existing = await outboundQueue.getJob(jobId);
    let job = existing;
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') await existing.retry();
      if (state === 'completed') {
        await existing.remove();
        job = await outboundQueue.add('index-business-document', { documentId: jobId }, { jobId });
      }
    } else {
      job = await outboundQueue.add('index-business-document', { documentId: jobId }, { jobId });
    }

    await BusinessDocument.updateOne(
      { _id: documentId, status: { $in: RECOVERABLE_STATUSES } },
      { $set: { status: 'queued', queuedAt: new Date(), error: null, errorCode: null } }
    );
    logger.info('[ragQueue] documento encolado', {
      documentId: jobId,
      businessId: String(document.business),
      version: document.version,
      status: 'queued',
      jobId,
    });
    return job;
  } catch (error) {
    await BusinessDocument.updateOne(
      { _id: documentId, status: { $in: RECOVERABLE_STATUSES } },
      { $set: { status: 'enqueue_failed', error: error.message.slice(0, 500), errorCode: 'queue_unavailable' } }
    ).catch(() => {});
    throw error;
  }
}

async function recoverStuckBusinessDocuments({ limit = 200, staleMs = DEFAULT_STALE_MS } = {}) {
  const staleBefore = new Date(Date.now() - staleMs);

  // Normaliza el estado legacy: `replacing` era el documento todavía activo,
  // no la nueva generación. Sus chunks siguen siendo la fuente usable.
  const replacing = await BusinessDocument.find({ status: 'replacing', updatedAt: { $lt: staleBefore } })
    .limit(limit)
    .select('_id business version');
  for (const document of replacing) {
    const hasActiveChunks = await BusinessDocumentChunk.exists({ documentId: document._id, active: true });
    if (hasActiveChunks) {
      await BusinessDocument.updateOne({ _id: document._id, status: 'replacing' }, { $set: { status: 'active' } });
    }
  }

  await BusinessDocument.updateMany(
    { status: 'processing', processingStartedAt: { $lt: staleBefore } },
    {
      $set: {
        status: 'queued',
        error: 'Procesamiento interrumpido; pendiente de recovery',
        errorCode: 'processing_stale',
        processingStartedAt: null,
      },
    }
  );

  const candidates = await BusinessDocument.find({
    $or: [
      { status: { $in: ['uploaded', 'enqueue_failed'] } },
      { status: 'queued', $or: [{ queuedAt: null }, { queuedAt: { $lt: staleBefore } }] },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id business version status predecessor');

  let recovered = 0;
  for (const document of candidates) {
    try {
      await enqueueIndexBusinessDocument({ documentId: document._id });
      recovered += 1;
    } catch (error) {
      logger.error('[ragQueue] recovery no pudo encolar documento', {
        documentId: String(document._id),
        businessId: String(document.business),
        version: document.version,
        status: document.status,
        jobId: String(document._id),
        failureReason: 'queue_unavailable',
        predecessorId: document.predecessor ? String(document.predecessor) : null,
      });
    }
  }
  return recovered;
}

module.exports = {
  DEFAULT_STALE_MS,
  RECOVERABLE_STATUSES,
  getIndexBusinessDocumentQueue,
  enqueueIndexBusinessDocument,
  recoverStuckBusinessDocuments,
};
