const mongoose = require('mongoose');

const importSchema = new mongoose.Schema(
  {
    business:  { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fileName:  String,
    fileType:  { type: String, enum: ['csv', 'xlsx', 'xls', 'google_sheets'] },
    fileSize:  Number,
    sheetUrl:  String,
    status: {
      type:    String,
      enum:    ['pending', 'processing', 'completed', 'failed', 'partial'],
      default: 'pending',
    },
    totalRows:      { type: Number, default: 0 },
    successCount:   { type: Number, default: 0 },
    errorCount:     { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    errors: [
      {
        row:     Number,
        field:   String,
        value:   String,
        message: String,
      },
    ],
    columnMapping: mongoose.Schema.Types.Mixed,
    defaults: {
      pipelineStage: String,
      source:        String,
      assignedTo:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      tags:          [String],
    },
    startedAt:        Date,
    completedAt:      Date,
    processingTimeMs: Number,
  },
  // `errors` es parte del contrato persistido y de la API de importaciones.
  // Mongoose lo permite; solo se silencia el warning de nombre reservado en
  // este schema para evitar renombrar datos existentes sin una migración.
  { timestamps: true, suppressReservedKeysWarning: true }
);

module.exports = mongoose.model('Import', importSchema);
