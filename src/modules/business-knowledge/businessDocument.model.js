const mongoose = require('mongoose');

// Bloque 3 de la auditoría Business Brain (§45-50, 20/sep/2026) — RAG del
// PDF. Una fila por cada GENERACIÓN de PDF subido (a diferencia de
// Business.pdfUrl/pdfSummary, que se pisan en el propio documento de
// Business en cada reemplazo, sin historial). El cutover entre
// generaciones es una transacción real (ver pdfIngestion.service.js) —
// este modelo es el que permite que 2 generaciones coexistan
// momentáneamente durante el reemplazo sin perder la vieja hasta que la
// nueva esté lista.
const ESTADOS = [
  'uploaded', 'enqueue_failed', 'queued', 'processing', 'ready', 'active',
  'failed', 'replacing', 'archived',
];

const businessDocumentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    // Autoincremental por negocio — responsabilidad del service (mismo
    // criterio que Policy.version: decidir el número no es una regla de
    // schema), nunca del propio schema.
    version: { type: Number, required: true, min: 1 },

    predecessor: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessDocument', default: null },

    sourceAsset: {
      publicId: { type: String, required: true },
      resourceType: { type: String, required: true },
      _id: false,
    },

    status: { type: String, enum: ESTADOS, default: 'uploaded' },
    // Texto crudo extraído antes de responder al upload. Persistirlo hace
    // durable la intención: recovery puede reconstruir el job aunque Redis
    // haya fallado después del save inicial.
    sourceText: { type: String, default: '' },
    chunkCount: { type: Number, default: 0 },
    // Motivo del fallo (extracción, embeddings, etc.) — visible en el
    // dashboard para que el dueño del negocio entienda por qué su PDF no
    // se indexó, sin exponer el stack trace real.
    error: { type: String, default: null },
    errorCode: { type: String, default: null },
    attemptCount: { type: Number, default: 0, min: 0 },
    queuedAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },

    readyAt: { type: Date, default: null },
    activeAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

businessDocumentSchema.index({ business: 1, version: -1 }, { unique: true, name: 'business_1_version_unique' });
businessDocumentSchema.index({ business: 1, status: 1 });
businessDocumentSchema.index({ status: 1, queuedAt: 1, processingStartedAt: 1 });

module.exports = mongoose.model('BusinessDocument', businessDocumentSchema);
module.exports.ESTADOS = ESTADOS;
