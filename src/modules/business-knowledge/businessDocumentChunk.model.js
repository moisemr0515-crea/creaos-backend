const mongoose = require('mongoose');

// Bloque 3 de la auditoría Business Brain (§45-51, 20/sep/2026) — un
// fragmento de un BusinessDocument, con su embedding para retrieval
// semántico (Atlas Vector Search). `active` es el ÚNICO campo que decide
// si un chunk participa del retrieval — se filtra DIRECTO en la query
// (`{business, active:true}`, dentro del propio $vectorSearch), nunca vía
// un $lookup a BusinessDocument por query (mismo principio ya vigente en
// knowledgeRetrieval.service.js: "los filtros no deben depender de un paso
// aparte" — acá aplicado a evitar un join innecesario en el camino
// caliente de cada búsqueda).
//
// `documentId`/`documentVersion` quedan para trazabilidad/debug (poder ver
// de qué generación viene un chunk) — el cutover transaccional
// (pdfIngestion.service.js) es quien flipea `active` de forma atómica
// entre generaciones, nunca una query de retrieval decide esto.
const businessDocumentChunkSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessDocument', required: true },
    documentVersion: { type: Number, required: true },
    chunkIndex: { type: Number, required: true },
    // best-effort — null si pdf-parse no dejó separadores de página
    // detectables (ver pdfChunking.util.js#separarPorPagina()).
    page: { type: Number, default: null },
    text: { type: String, required: true, maxlength: 2000 },
    embedding: { type: [Number], required: true },
    active: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

businessDocumentChunkSchema.index({ business: 1, active: 1 });
businessDocumentChunkSchema.index({ documentId: 1, chunkIndex: 1 });

module.exports = mongoose.model('BusinessDocumentChunk', businessDocumentChunkSchema);
