const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const webhookConfigSchema = new mongoose.Schema(
  {
    business:    { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    platform:    { type: String, enum: ['meta', 'tiktok', 'gupshup'], required: true },
    verifyToken: { type: String, default: () => uuidv4() },
    accessToken: String,   // Page Access Token (Meta) / TikTok API key
    pageId:      String,   // Meta: Facebook Page ID / Gupshup: App Name
    adAccountId: String,   // Meta Ad Account ID / TikTok Advertiser ID
    formIds:     [String], // Filtrar formularios específicos (vacío = todos)
    defaults: {
      pipelineStage: { type: String, default: 'new' },
      source:        String,
      assignedTo:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      tags:          [String],
      temperature:   { type: String, enum: ['cold', 'warm', 'hot'], default: 'warm' },
    },
    isActive:           { type: Boolean, default: true },
    lastReceivedAt:     Date,
    totalLeadsReceived: { type: Number, default: 0 },
  },
  { timestamps: true }
);

webhookConfigSchema.index({ business: 1, platform: 1 });
webhookConfigSchema.index({ verifyToken: 1 }, { unique: true });
webhookConfigSchema.index({ pageId: 1, platform: 1 });
webhookConfigSchema.index({ adAccountId: 1, platform: 1 });

module.exports = mongoose.model('WebhookConfig', webhookConfigSchema);
