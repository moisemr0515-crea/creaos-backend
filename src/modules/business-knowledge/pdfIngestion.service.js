const mongoose = require('mongoose');
const BusinessDocument = require('./businessDocument.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');
const { chunkearDocumento } = require('./pdfChunking.util');
const { generarEmbeddings } = require('../../utils/embeddings');
const logger = require('../../utils/logger');

const MIN_INDEXABLE_TEXT_LENGTH = 50;
const VERSION_RETRIES = 8;
const RECOVERABLE_PROCESSING_STATUSES = ['uploaded', 'enqueue_failed', 'queued'];

function cleanIndexableText(text) {
  return String(text || '')
    .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeError(error) {
  return String(error?.message || 'Error de procesamiento').slice(0, 500);
}

function isDuplicateVersion(error) {
  return error?.code === 11000
    && (error?.keyPattern?.business || error?.keyPattern?.version || /business_1_version/i.test(error?.message || ''));
}

/**
 * Crea una generación con secuencia única por negocio. El índice único
 * business+version es la garantía final; el retry resuelve carreras entre
 * uploads concurrentes sin depender de un lock en memoria.
 */
async function iniciarNuevoDocumento(businessId, sourceAsset, sourceText = '') {
  for (let intento = 1; intento <= VERSION_RETRIES; intento += 1) {
    const ultimo = await BusinessDocument.findOne({ business: businessId }).sort({ version: -1, _id: -1 });
    try {
      const documento = await BusinessDocument.create({
        business: businessId,
        version: (ultimo?.version || 0) + 1,
        predecessor: ultimo?._id || null,
        sourceAsset,
        sourceText,
        status: 'uploaded',
      });
      logger.info('[pdfIngestion] documento creado', {
        documentId: String(documento._id),
        businessId: String(documento.business),
        version: documento.version,
        status: documento.status,
        predecessorId: documento.predecessor ? String(documento.predecessor) : null,
      });
      return { documento, documentoAnteriorId: documento.predecessor || null };
    } catch (error) {
      if (!isDuplicateVersion(error) || intento === VERSION_RETRIES) throw error;
    }
  }
  throw new Error('No se pudo reservar una versión de documento');
}

async function ejecutarCutover({ documento, documentoAnterior, chunksTexto, embeddings }) {
  const prepararChunksNuevos = async (opts = {}) => {
    await BusinessDocumentChunk.deleteMany({ documentId: documento._id }, opts);
    if (!chunksTexto.length) return;
    await BusinessDocumentChunk.insertMany(
      chunksTexto.map((chunk, index) => ({
        business: documento.business,
        documentId: documento._id,
        documentVersion: documento.version,
        chunkIndex: chunk.chunkIndex,
        page: chunk.page,
        text: chunk.text,
        embedding: embeddings[index],
        active: false,
      })),
      opts
    );
  };

  const marcarListo = async (opts = {}) => {
    await BusinessDocument.updateOne(
      { _id: documento._id, business: documento.business },
      {
        $set: {
          status: 'ready',
          chunkCount: chunksTexto.length,
          readyAt: new Date(),
          error: null,
          errorCode: null,
        },
      },
      opts
    );
  };

  const activarNuevaVersion = async (opts = {}) => {
    if (documentoAnterior && String(documentoAnterior._id) !== String(documento._id)) {
      await BusinessDocumentChunk.updateMany({ documentId: documentoAnterior._id }, { $set: { active: false } }, opts);
      await BusinessDocument.updateOne(
        { _id: documentoAnterior._id, business: documento.business },
        { $set: { status: 'archived', archivedAt: new Date() } },
        opts
      );
    }
    await BusinessDocumentChunk.updateMany({ documentId: documento._id }, { $set: { active: true } }, opts);
    await BusinessDocument.updateOne(
      { _id: documento._id, business: documento.business, status: 'ready' },
      { $set: { status: 'active', activeAt: new Date() } },
      opts
    );
  };

  const ejecutar = async (session) => {
    const opts = session ? { session } : {};
    await prepararChunksNuevos(opts);
    await marcarListo(opts);
    await activarNuevaVersion(opts);
  };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => ejecutar(session));
  } catch (txError) {
    const standalone = txError.message?.includes('replica set')
      || txError.message?.includes('Transaction numbers')
      || txError.codeName === 'IllegalOperation';
    if (!standalone) throw txError;
    await ejecutar(null);
  } finally {
    await session.endSession();
  }
}

async function resolveDocumentoAnterior(documento) {
  let predecessor = documento.predecessor
    ? await BusinessDocument.findOne({ _id: documento.predecessor, business: documento.business })
    : null;

  if (predecessor && ['uploaded', 'enqueue_failed', 'queued', 'processing'].includes(predecessor.status)) {
    const error = new Error(`La versión predecesora ${predecessor.version} todavía no está lista`);
    error.code = 'PREDECESSOR_NOT_READY';
    error.retryable = true;
    throw error;
  }

  if (!predecessor || ['failed', 'archived'].includes(predecessor.status)) {
    predecessor = await BusinessDocument.findOne({
      business: documento.business,
      _id: { $ne: documento._id },
      status: { $in: ['active', 'ready', 'replacing'] },
    }).sort({ version: -1 });
    if (predecessor && String(documento.predecessor || '') !== String(predecessor._id)) {
      documento.predecessor = predecessor._id;
      await documento.save();
    }
  }
  return predecessor;
}

/**
 * Procesa una generación reclamada de forma atómica. Los reintentos leen el
 * texto persistido; nunca dependen del payload efímero del job.
 */
async function procesarDocumento(documentId, options = {}) {
  const attempt = Math.max(1, Number(options.attempt || 1));
  const maxAttempts = Math.max(attempt, Number(options.maxAttempts || 1));
  const documento = await BusinessDocument.findOneAndUpdate(
    { _id: documentId, status: { $in: RECOVERABLE_PROCESSING_STATUSES } },
    {
      $set: {
        status: 'processing',
        processingStartedAt: new Date(),
        error: null,
        errorCode: null,
      },
      $inc: { attemptCount: 1 },
    },
    { new: true }
  );

  if (!documento) {
    const existente = await BusinessDocument.findById(documentId);
    if (!existente) throw new Error(`BusinessDocument ${documentId} no encontrado`);
    if (['active', 'archived'].includes(existente.status)) {
      return { documento: existente, chunkCount: existente.chunkCount, alreadyProcessed: true };
    }
    throw new Error(`BusinessDocument ${documentId} no es reclamable desde status ${existente.status}`);
  }

  logger.info('[pdfIngestion] procesamiento iniciado', {
    documentId: String(documento._id),
    businessId: String(documento.business),
    version: documento.version,
    status: documento.status,
    retryCount: attempt - 1,
    predecessorId: documento.predecessor ? String(documento.predecessor) : null,
  });

  if (cleanIndexableText(documento.sourceText).length < MIN_INDEXABLE_TEXT_LENGTH) {
    documento.status = 'failed';
    documento.errorCode = 'no_indexable_text';
    documento.error = 'El PDF no contiene texto indexable.';
    await documento.save();
    await BusinessDocumentChunk.deleteMany({ documentId: documento._id });
    return { documento, chunkCount: 0, failed: true };
  }

  try {
    const documentoAnterior = await resolveDocumentoAnterior(documento);
    const chunksTexto = chunkearDocumento(documento.sourceText);
    if (!chunksTexto.length) {
      const error = new Error('El PDF no contiene texto indexable.');
      error.code = 'NO_INDEXABLE_TEXT';
      throw error;
    }
    const embeddings = await generarEmbeddings(chunksTexto.map((chunk) => chunk.text));
    if (embeddings.length !== chunksTexto.length || embeddings.some((embedding) => !Array.isArray(embedding) || !embedding.length)) {
      throw new Error('La generación de embeddings devolvió un resultado incompleto');
    }

    await ejecutarCutover({ documento, documentoAnterior, chunksTexto, embeddings });
    const final = await BusinessDocument.findById(documento._id);
    logger.info('[pdfIngestion] documento activado', {
      documentId: String(final._id),
      businessId: String(final.business),
      version: final.version,
      status: final.status,
      predecessorId: final.predecessor ? String(final.predecessor) : null,
      activeDocumentId: String(final._id),
    });
    return { documento: final, chunkCount: chunksTexto.length };
  } catch (error) {
    const noIndexable = error.code === 'NO_INDEXABLE_TEXT';
    const retryable = error.retryable === true || (!noIndexable && attempt < maxAttempts);
    documento.status = retryable ? 'queued' : 'failed';
    documento.errorCode = noIndexable ? 'no_indexable_text' : (retryable ? 'processing_retryable' : 'processing_failed');
    documento.error = noIndexable ? 'El PDF no contiene texto indexable.' : safeError(error);
    documento.processingStartedAt = null;
    await documento.save();
    if (!retryable) await BusinessDocumentChunk.deleteMany({ documentId: documento._id, active: false });

    logger.error('[pdfIngestion] procesamiento falló', {
      documentId: String(documento._id),
      businessId: String(documento.business),
      version: documento.version,
      status: documento.status,
      retryCount: attempt - 1,
      failureReason: documento.errorCode,
      predecessorId: documento.predecessor ? String(documento.predecessor) : null,
    });
    if (noIndexable) return { documento, chunkCount: 0, failed: true };
    throw error;
  }
}

module.exports = {
  MIN_INDEXABLE_TEXT_LENGTH,
  iniciarNuevoDocumento,
  procesarDocumento,
  ejecutarCutover,
};
