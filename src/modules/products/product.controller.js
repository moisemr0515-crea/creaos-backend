const productService = require('./product.service');
const { createProductSchema, updateProductSchema, listProductsSchema } = require('./product.validator');
const { validateBody, validateQuery } = require('../../shared/utils/validate');
const { respuestaExito, buildMeta } = require('../../utils/response');

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

module.exports = {
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
  deactivateProduct,
};
