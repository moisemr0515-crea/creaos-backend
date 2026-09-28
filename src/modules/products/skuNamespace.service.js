const Product = require('./product.model');
const Variant = require('./variant.model');
const { AppError } = require('../../middleware/error.middleware');

const normalizeSku = (sku) => String(sku || '').trim().toUpperCase();

/**
 * Namespace único lógico para Product y Variant, siempre acotado al tenant.
 * Las exclusiones permiten actualizar el dueño actual sin auto-colisión.
 */
async function assertSkuAvailable(businessId, sku, { excludeProductId, excludeVariantId } = {}) {
  const normalizedSku = normalizeSku(sku);
  const productFilter = { business: businessId, sku: normalizedSku };
  const variantFilter = { business: businessId, sku: normalizedSku };
  if (excludeProductId) productFilter._id = { $ne: excludeProductId };
  if (excludeVariantId) variantFilter._id = { $ne: excludeVariantId };

  const [product, variant] = await Promise.all([
    Product.findOne(productFilter).select('_id sku').lean(),
    Variant.findOne(variantFilter).select('_id sku').lean(),
  ]);
  if (product || variant) {
    throw new AppError(`El SKU "${normalizedSku}" ya está en uso en este negocio`, 409);
  }
  return normalizedSku;
}

module.exports = { assertSkuAvailable, normalizeSku };
