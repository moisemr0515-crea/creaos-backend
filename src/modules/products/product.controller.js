const productService = require('./product.service');
const productAssetAccess = require('./productAssetAccess.service');
const productInventoryService = require('./productInventory.service');
const { createProductSchema, updateProductSchema, listProductsSchema } = require('./product.validator');
const { createVariantSchema, updateVariantSchema } = require('./variant.validator');
const { validateBody, validateQuery } = require('../../shared/utils/validate');
const { respuestaExito, buildMeta } = require('../../utils/response');
const { AppError } = require('../../middleware/error.middleware');

// CREA Product Intelligence™ V1.0 — Etapa 3/10. `req.businessId` viene
// SIEMPRE de injectTenant (product.routes.js), nunca de req.body/req.query
// — el mismo principio de multi-tenant ya validado en el resto del backend
// (documento maestro §25: "nunca confiar en un tenant_id enviado por el
// cliente si se puede derivar del token/sesión").
const actor = (req) => ({ _id: req.user._id, name: req.user.name });

const createProduct = async (req, res, next) => {
  try {
    const data = await validateBody(createProductSchema, req.body);
    const producto = await productService.crearProducto(req.businessId, actor(req), data);
    return respuestaExito(res, { statusCode: 201, message: 'Producto creado exitosamente', data: { producto } });
  } catch (err) {
    next(err);
  }
};

const getProduct = async (req, res, next) => {
  try {
    const producto = await productService.obtenerProducto(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Producto obtenido exitosamente', data: { producto } });
  } catch (err) {
    next(err);
  }
};

const listProducts = async (req, res, next) => {
  try {
    const filtros = await validateQuery(listProductsSchema, req.query);
    const { productos, total } = await productService.listarProductos(req.businessId, filtros);
    const { page, limit } = filtros;
    return respuestaExito(res, {
      message: 'Productos obtenidos exitosamente',
      data: { productos },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
};

const updateProduct = async (req, res, next) => {
  try {
    const data = await validateBody(updateProductSchema, req.body);
    const producto = await productService.actualizarProducto(req.businessId, req.params.id, actor(req), data);
    return respuestaExito(res, { message: 'Producto actualizado exitosamente', data: { producto } });
  } catch (err) {
    next(err);
  }
};

// DELETE /:id NUNCA borra — desactiva (active:false). Mismo verbo HTTP que
// eliminarLead() (que tampoco borra, hace softDelete), por consistencia con
// el resto de la API; el significado real ("desactivar, no destruir") queda
// documentado acá y en product.service.js#desactivarProducto.
const deactivateProduct = async (req, res, next) => {
  try {
    const producto = await productService.desactivarProducto(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Producto desactivado exitosamente', data: { producto } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/products/:id/photos
 * Bloque 2 (§37-39, 20/sep/2026) — sube una foto nueva para ESTE producto
 * puntual (a diferencia de POST /businesses/current/photos, genérico del
 * negocio). `isPrimary`/`caption` opcionales en el body (multipart).
 */
const uploadProductPhoto = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Se requiere un archivo de imagen', 400);

    const isPrimary = req.body.isPrimary === 'true' || req.body.isPrimary === true;
    const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() || undefined : undefined;

    const producto = await productService.agregarFotoProducto(req.businessId, req.params.id, req.file, { caption, isPrimary });
    return respuestaExito(res, { statusCode: 201, message: 'Foto agregada exitosamente', data: { producto } });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/products/:id/photos/:mediaId
 */
const deleteProductPhoto = async (req, res, next) => {
  try {
    const producto = await productService.eliminarFotoProducto(req.businessId, req.params.id, req.params.mediaId);
    return respuestaExito(res, { message: 'Foto eliminada exitosamente', data: { producto } });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/products/:id/photos/:mediaId/access
 * Mismo rol que GET /businesses/current/assets/:campo/access (Bloque 1) —
 * nunca se expone el publicId/URL directa, solo un acceso firmado con
 * expiración real. `proposito` default 'display' — 'send' es solo para
 * send_product_photos (ai/tools/index.js), invocado directo como función,
 * nunca vía este endpoint HTTP.
 */
const getProductPhotoAccess = async (req, res, next) => {
  try {
    const producto = await productService.obtenerProducto(req.businessId, req.params.id);
    const url = productAssetAccess.obtenerUrlDeAccesoFotoPorId(producto, req.params.mediaId, 'display');
    if (!url) throw new AppError('Foto no encontrada', 404);

    return respuestaExito(res, { message: 'Acceso generado', data: { url } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/products/:id/variants
 * Bloque 4 (§61, 20/sep/2026) — crea una variante para ESTE producto.
 * Marca hasVariants:true en el producto automáticamente en la primera
 * variante real (ver productInventory.service.js#crearVariante()).
 */
const createVariant = async (req, res, next) => {
  try {
    const data = await validateBody(createVariantSchema, req.body);
    const variante = await productInventoryService.crearVariante(req.businessId, req.params.id, data);
    return respuestaExito(res, { statusCode: 201, message: 'Variante creada exitosamente', data: { variante } });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/products/:id/variants
 * Sin filtro de active — vista de administración (mismo criterio que
 * GET /api/v1/products/:id).
 */
const listVariants = async (req, res, next) => {
  try {
    const variantes = await productInventoryService.listarVariantes(req.businessId, req.params.id);
    return respuestaExito(res, { message: 'Variantes obtenidas exitosamente', data: { variantes } });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/v1/products/:id/variants/:variantId
 */
const updateVariant = async (req, res, next) => {
  try {
    const data = await validateBody(updateVariantSchema, req.body);
    const variante = await productInventoryService.actualizarVariante(req.businessId, req.params.id, req.params.variantId, data);
    return respuestaExito(res, { message: 'Variante actualizada exitosamente', data: { variante } });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/products/:id/variants/:variantId
 * NUNCA borra — desactiva (active:false), mismo criterio que
 * deactivateProduct() de arriba.
 */
const deactivateVariant = async (req, res, next) => {
  try {
    const variante = await productInventoryService.desactivarVariante(req.businessId, req.params.id, req.params.variantId);
    return respuestaExito(res, { message: 'Variante desactivada exitosamente', data: { variante } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
  deactivateProduct,
  uploadProductPhoto,
  deleteProductPhoto,
  getProductPhotoAccess,
  createVariant,
  listVariants,
  updateVariant,
  deactivateVariant,
};
