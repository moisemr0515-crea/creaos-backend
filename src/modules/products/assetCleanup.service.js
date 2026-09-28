const { cloudinary } = require('../../utils/cloudinary');
const AssetCleanup = require('./assetCleanup.model');
const logger = require('../../utils/logger');

const safeError = (error) => String(error?.message || 'Cloudinary cleanup failed').slice(0, 500);

async function recordPendingCleanup({ businessId, asset, reason, error }) {
  return AssetCleanup.findOneAndUpdate(
    {
      business: businessId,
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType || 'authenticated',
    },
    {
      $set: { status: 'pending', reason, lastError: safeError(error) },
      $inc: { attemptCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function destroyAssetOrRecordPending({ businessId, asset, reason }) {
  try {
    await cloudinary.uploader.destroy(asset.publicId, {
      resource_type: asset.resourceType,
      type: asset.deliveryType || 'authenticated',
    });
    await AssetCleanup.deleteOne({
      business: businessId,
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType || 'authenticated',
    });
    return { cleaned: true };
  } catch (error) {
    try {
      await recordPendingCleanup({ businessId, asset, reason, error });
    } catch (recordError) {
      logger.error('[assetCleanup] no se pudo persistir cleanup pendiente', {
        businessId: String(businessId),
        publicId: asset.publicId,
        reason,
        cleanupError: safeError(error),
        recordError: safeError(recordError),
      });
    }
    return { cleaned: false, pending: true, error };
  }
}

module.exports = { destroyAssetOrRecordPending, recordPendingCleanup };
