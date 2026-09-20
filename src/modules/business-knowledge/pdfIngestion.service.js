const mongoose = require('mongoose');
const BusinessDocument = require('./businessDocument.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');
const { chunkearDocumento } = require('./pdfChunking.util');
const { generarEmbeddings } = require('../../utils/embeddings');
const logger = require('../../utils/logger');

// Bloque 3 de la auditoría Business Brain (§45-50, 20/sep/2026) — RAG del
// PDF. Este service tiene 2 mitades con audiencias distintas:
//   1. iniciarNuevoDocumento() — SÍNCRONA, se llama desde
//      business.service.js#subirPdf() en el mismo request HTTP del
//      upload. Solo crea el registro y marca la generación anterior como
//      'replacing' — rápido, sin llamadas a OpenAI todavía.
//   2. procesarDocumento() — ASÍNCRONA, la corre el worker de BullMQ
//      (indexBusinessDocument.worker.js) fuera del request HTTP: chunkea,
//      pide los embeddings (llamada de red a OpenAI, puede tardar) y hace
//      el cutover transaccional.
// Nunca deja al negocio sin chunks activos mientras se procesa un
// reemplazo: el documento anterior sigue con sus chunks `active:true`
// hasta el instante exacto en que el cutover de la nueva generación
// commitea (o para siempre, si el nuevo documento falla).

/**
 * Paso 1/2 — crea la nueva generación (status:'uploaded') y, si había una
 * generación 'ready', la pasa a 'replacing' (marca puramente informativa
 * para el dashboard — sus chunks NO se tocan acá, siguen `active:true`).
 * @param {string} businessId
 * @param {{publicId: string, resourceType: string}} sourceAsset
 * @returns {Promise<{documento: object, documentoAnteriorId: string|null}>}
 */
const iniciarNuevoDocumento = async (businessId, sourceAsset) => {
  const ultimo = await BusinessDocument.findOne({ business: businessId }).sort({ version: -1 });
  const version = (ultimo?.version || 0) + 1;

  const documentoAnterior = await BusinessDocument.findOneAndUpdate(
    { business: businessId, status: 'ready' },
    { status: 'replacing' },
    { new: true }
  );

  const documento = await BusinessDocument.create({ business: businessId, version, sourceAsset, status: 'uploaded' });

  return { documento, documentoAnteriorId: documentoAnterior?._id || null };
};

/**
 * Inserta los chunks nuevos + marca el documento nuevo 'ready' + archiva
 * la generación anterior (si había una) — TODO en una transacción real.
 * Fallback a operaciones secuenciales si Mongo no soporta transacciones
 * (standalone, mismo criterio EXACTO que auth.service.js#registrar():
 * Atlas/replica set en producción, standalone en dev/test local).
 */
const ejecutarCutover = async ({ documento, documentoAnterior, chunksTexto, embeddings }) => {
  const insertarChunksNuevos = (opts) =>
    BusinessDocumentChunk.insertMany(
      chunksTexto.map((c, i) => ({
        business: documento.business,
        documentId: documento._id,
        documentVersion: documento.version,
        chunkIndex: c.chunkIndex,
        page: c.page,
        text: c.text,
        embedding: embeddings[i],
        active: true,
      })),
      opts
    );

  const marcarDocumentoNuevoListo = (opts) => {
    documento.status = 'ready';
    documento.chunkCount = chunksTexto.length;
    documento.readyAt = new Date();
    return documento.save(opts);
  };

  const archivarDocumentoAnterior = async (opts) => {
    if (!documentoAnterior) return;
    await BusinessDocumentChunk.updateMany({ documentId: documentoAnterior._id }, { active: false }, opts);
    documentoAnterior.status = 'archived';
    await documentoAnterior.save(opts);
  };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await insertarChunksNuevos({ session });
      await marcarDocumentoNuevoListo({ session });
      await archivarDocumentoAnterior({ session });
    });
  } catch (txError) {
    // Mismo criterio exacto que auth.service.js#registrar(): MongoDB
    // standalone (dev/test local) no soporta transacciones — se cae a
    // operaciones secuenciales. En producción (Atlas, replica set real)
    // esta rama nunca se ejecuta.
    if (txError.message?.includes('replica set') || txError.message?.includes('Transaction numbers') || txError.codeName === 'IllegalOperation') {
      await insertarChunksNuevos();
      await marcarDocumentoNuevoListo();
      await archivarDocumentoAnterior();
    } else {
      throw txError;
    }
  } finally {
    await session.endSession();
  }
};

/**
 * Paso 2/2 — chunkea el texto completo (sin truncar, a diferencia de
 * pdfExtractedText/pdfSummary que sí truncan a 5000/800 caracteres), pide
 * los embeddings en batch y ejecuta el cutover. Si algo falla en el
 * camino, el documento nuevo queda 'failed' y el anterior (si estaba
 * 'replacing') VUELVE a 'ready' sin que ninguno de sus chunks se haya
 * tocado nunca — un fallo deja al negocio exactamente como estaba antes
 * del intento de reemplazo.
 * @param {string} documentId
 * @param {string} textoCompleto — texto crudo de pdf-parse, SIN limpiar
 *   los separadores de página (pdfChunking.util.js los necesita para
 *   derivar `page`).
 */
const procesarDocumento = async (documentId, textoCompleto) => {
  const documento = await BusinessDocument.findById(documentId);
  if (!documento) throw new Error(`BusinessDocument ${documentId} no encontrado`);

  documento.status = 'processing';
  await documento.save();

  const documentoAnterior = await BusinessDocument.findOne({ business: documento.business, status: 'replacing' });

  try {
    const chunksTexto = chunkearDocumento(textoCompleto);

    // PDF sin texto extraíble (escaneado/de imágenes) — mismo criterio que
    // MIN_PDF_TEXT_LENGTH en business.service.js: no es un error, es un
    // estado real. El documento queda 'ready' con 0 chunks (no hay nada
    // que indexar); el anterior se archiva igual, porque ESTE reemplazo sí
    // se completó (aunque no haya nada que mostrar).
    const embeddings = chunksTexto.length ? await generarEmbeddings(chunksTexto.map((c) => c.text)) : [];

    await ejecutarCutover({ documento, documentoAnterior, chunksTexto, embeddings });

    return { documento, chunkCount: chunksTexto.length };
  } catch (error) {
    logger.error(`[pdfIngestion] procesarDocumento(${documentId}) falló: ${error.message}`);

    documento.status = 'failed';
    documento.error = error.message;
    await documento.save();

    if (documentoAnterior) {
      documentoAnterior.status = 'ready';
      await documentoAnterior.save();
    }

    throw error;
  }
};

module.exports = { iniciarNuevoDocumento, procesarDocumento, ejecutarCutover };
