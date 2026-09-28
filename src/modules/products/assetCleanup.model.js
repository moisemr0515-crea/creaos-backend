const mongoose = require('mongoose');

const assetCleanupSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, required: true },
    deliveryType: { type: String, enum: ['authenticated', 'upload'], default: 'authenticated' },
    reason: { type: String, enum: ['upload_db_failure', 'delete_provider_failure'], required: true },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    lastError: { type: String, default: null },
    attemptCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

assetCleanupSchema.index(
  { business: 1, publicId: 1, resourceType: 1, deliveryType: 1 },
  { unique: true, name: 'asset_cleanup_identity_unique' }
);

module.exports = mongoose.model('AssetCleanup', assetCleanupSchema);
