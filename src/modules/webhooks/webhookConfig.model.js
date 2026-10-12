const mongoose = require('mongoose');

const cipherFieldSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    algorithm: { type: String, required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    keyVersion: { type: Number, required: true },
  },
  { _id: false }
);

const removeSecrets = (_doc, ret) => {
  delete ret.verifyToken;
  delete ret.accessToken;
  delete ret.verifyTokenEncrypted;
  delete ret.accessTokenEncrypted;
  return ret;
};

const webhookConfigSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    platform: { type: String, enum: ['meta', 'tiktok', 'gupshup'], required: true },

    // Campos legacy: siguen en el schema únicamente para leer/migrar registros
    // existentes sin downtime. Nuevas escrituras usan siempre los campos GCM.
    // verifyToken conserva un marcador hash no reversible (`enc:v1:<sha256>`)
    // para reutilizar de forma segura el índice unique ya desplegado.
    verifyToken: { type: String, select: false },
    accessToken: { type: String, select: false },
    verifyTokenEncrypted: { type: cipherFieldSchema, select: false, default: null },
    accessTokenEncrypted: { type: cipherFieldSchema, select: false, default: null },

    accessTokenExpiresAt: { type: Date, default: null },
    pageId: String,
    pageName: String,
    adAccountId: String,
    formIds: [String],
    defaults: {
      pipelineStage: { type: String, default: 'new' },
      source: String,
      assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      tags: [String],
      temperature: { type: String, enum: ['cold', 'warm', 'hot'], default: 'warm' },
    },
    isActive: { type: Boolean, default: true },
    lastReceivedAt: Date,
    totalLeadsReceived: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { transform: removeSecrets },
    toObject: { transform: removeSecrets },
  }
);

webhookConfigSchema.index({ business: 1, platform: 1 });
webhookConfigSchema.index({ verifyToken: 1 }, { unique: true });
webhookConfigSchema.index({ pageId: 1, platform: 1 });
webhookConfigSchema.index({ adAccountId: 1, platform: 1 });

module.exports = mongoose.model('WebhookConfig', webhookConfigSchema);
