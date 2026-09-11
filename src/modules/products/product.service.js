const Product = require('./product.model');
const Business = require('../businesses/business.model');
const { AppError } = require('../../middleware/error.middleware');

// CREA Product Intelligence™ V1.0 — Etapa 2/10 (modelo + service). Este
// archivo cubre 2 audiencias distintas:
//   1. CRUD de gestión manual (crearProducto/obtenerProducto/listarProductos/
//      actualizarProducto/desactivarProducto) — usado por el panel de
//      /business (Etapa 4) vía product.controller.js (Etapa 3).
//   2. Las 3 funciones que la IA consulta como tools (buscarProductos/
//      consultarStock/consultarPrecio) — usado por ai/tools/index.js
//      (Etapa 6). SIEMPRE reciben `businessId` ya resuelto por el caller
//      (el mismo objeto `business` que generateReply() recibe del canal/
//      webhook, ver ai.service.js) — ninguna de las 3 acepta ni confía en
//      un identificador de tenant que pueda venir de `args` del modelo de
//      IA (documento maestro §6/§25).

/**
 * Resuelve la moneda a mostrar: la propia del producto si está seteada, o
 * si no, la del negocio (`business.currency`, default 'MXN' — nunca un
 * literal hardcodeado acá). Documento maestro §5.1: "currency por default
 * desde la config del tenant".
 */
const resolverMoneda = (producto, business) => producto.currency || business.currency;

const verificarSkuDuplicado = async (businessId, sku, { excluirProductoId } = {}) => {
  const filtro = { business: businessId, sku: sku.trim().toUpperCase() };
  if (excluirProductoId) filtro._id = { $ne: excluirProductoId };

  const existente = await Product.findOne(filtro);
  if (existente) {
    throw new AppError(`Ya existe un producto con el SKU "${existente.sku}" en este negocio: ${existente.name}`, 409);
  }
};

/**
 * `actor` se recibe por consistencia con el resto de los services del
 * proyecto (crearLead, actualizarLead, etc. lo reciben aunque hoy Product
 * no tiene un `activity[]` a diferencia de Lead) — no se usa todavía. El
 * documento maestro (§28) pide logging de eventos (PRODUCT_CREATED, etc.)
 * en vez de un historial embebido en el documento; esa instrumentación se
 * agrega en la etapa que integra el actor real (Etapa 3, con req.user
 * disponible en el controller), para no loguear un `actor` a medias acá.
 */
const crearProducto = async (businessId, actor, data) => {
  await verificarSkuDuplicado(businessId, data.sku);

  const producto = new Product({
    ...data,
    business: businessId,
    source: data.source || 'manual',
  });

  await producto.save();
  return producto;
};

const obtenerProducto = async (businessId, productId) => {
  const producto = await Product.findOne({ _id: productId, business: businessId });
  if (!producto) throw new AppError('Producto no encontrado', 404);
  return producto;
};

/**
 * Variante usada SOLO por las 3 funciones de cara a la IA (más abajo) —
 * un producto desactivado nunca debe ser encontrable por check_stock()/
 * get_price(), aunque la conversación todavía tenga su productId guardado
 * en `Conversation.activeProduct` de un mensaje anterior (pudo desactivarse
 * entre un mensaje y el siguiente). Mismo error 404 genérico que
 * obtenerProducto() — no distingue "no existe" de "está desactivado" para
 * no filtrarle ese detalle interno al modelo de IA.
 */
const obtenerProductoActivo = async (businessId, productId) => {
  const producto = await Product.findOne({ _id: productId, business: businessId, active: true });
  if (!producto) throw new AppError('Producto no encontrado', 404);
  return producto;
};

const listarProductos = async (businessId, filtros = {}) => {
  const { page = 1, limit = 20, search, category, active } = filtros;
  const skip = (Number(page) - 1) * Number(limit);

  const query = { business: businessId };
  if (category) query.category = category;
  if (active !== undefined) query.active = active;
  if (search) query.$text = { $search: search };

  const [productos, total] = await Promise.all([
    Product.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { createdAt: -1 })
      .select(search ? { score: { $meta: 'textScore' } } : {})
      .skip(skip)
      .limit(Number(limit)),
    Product.countDocuments(query),
  ]);

  return { productos, total };
};

const actualizarProducto = async (businessId, productId, actor, data) => {
  const producto = await obtenerProducto(businessId, productId);

  if (data.sku !== undefined && data.sku.trim().toUpperCase() !== producto.sku) {
    await verificarSkuDuplicado(businessId, data.sku, { excluirProductoId: producto._id });
  }

  Object.assign(producto, data);
  await producto.save();
  return producto;
};

/**
 * "Eliminar" un producto en este dominio es SIEMPRE desactivarlo
 * (`active:false`) — nunca un borrado real. Documento maestro §9: "no
 * borrar información que pueda ser necesaria posteriormente para
 * trazabilidad". Confirmado con el usuario: reactivar no libera el SKU
 * para un producto distinto (ver el comentario del índice único en
 * product.model.js) — reactivar este mismo registro (active:true) sigue
 * siendo válido vía actualizarProducto(), no hace falta un método aparte.
 */
const desactivarProducto = async (businessId, productId) => {
  const producto = await obtenerProducto(businessId, productId);
  producto.active = false;
  await producto.save();
  return producto;
};

// Tope de resultados devueltos a la IA — el documento maestro (§15) no fija
// un número, pero "no meter todo el catálogo en el prompt" (§19) aplica
// también acá: el modelo no necesita más de un puñado de candidatos para
// desambiguar (§23, caso D).
const LIMITE_RESULTADOS_BUSQUEDA = 5;

/**
 * search_products() — documento maestro §13/§14/§15. Reusa el índice de
 * texto existente (`$text`, con `default_language:'spanish'` para tolerar
 * singular/plural, ver product.model.js) sobre name/description/category/
 * brand/keywords/synonyms — sin infraestructura de búsqueda vectorial
 * nueva, tal como permite §13.
 *
 * Solo busca entre productos `active:true` — uno desactivado no debe
 * aparecer nunca en una respuesta de venta.
 *
 * `matchScore` normaliza el `textScore` de Mongo (sin techo fijo) a una
 * escala 0–1 dividiendo por el score más alto del propio resultado — el
 * mejor match del lote siempre queda en 1.0, igual al ejemplo del
 * documento (§15). Es una normalización relativa a ESTE resultado, no un
 * score absoluto de confianza global; suficiente para V1 (§16: "no hace
 * falta un modelo ML propio").
 */
const buscarProductos = async (businessId, texto) => {
  if (!texto || !texto.trim()) return [];

  const business = await Business.findById(businessId);

  const resultados = await Product.find(
    { business: businessId, active: true, $text: { $search: texto } },
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(LIMITE_RESULTADOS_BUSQUEDA)
    .lean();

  if (!resultados.length) return [];

  const scoreMax = resultados[0].score;

  return resultados.map((p) => ({
    productId: p._id,
    sku: p.sku,
    name: p.name,
    price: p.price,
    currency: resolverMoneda(p, business),
    trackInventory: p.trackInventory,
    availableStock: p.physicalStock - p.reservedStock,
    active: p.active,
    matchScore: Math.round((p.score / scoreMax) * 100) / 100,
  }));
};

/**
 * check_stock() — documento maestro §17. `trackInventory:false` responde
 * `availability:'NOT_TRACKED'` en vez de cualquier número de stock — así
 * la IA nunca puede interpretar un servicio sin seguimiento de inventario
 * como "agotado" solo porque physicalStock quedó en su default (0).
 */
const consultarStock = async (businessId, productId) => {
  const producto = await obtenerProductoActivo(businessId, productId);

  if (!producto.trackInventory) {
    return { productId: producto._id, trackInventory: false, availability: 'NOT_TRACKED' };
  }

  const availableStock = producto.physicalStock - producto.reservedStock;
  return {
    productId: producto._id,
    trackInventory: true,
    physicalStock: producto.physicalStock,
    reservedStock: producto.reservedStock,
    availableStock,
    inStock: availableStock > 0,
    lowStock: availableStock > 0 && availableStock <= producto.minimumStock,
  };
};

/**
 * get_price() — documento maestro §18. `priceAvailable:false` cuando el
 * producto no tiene precio cargado — "la IA debe preguntar/derivar, nunca
 * inventar" un precio que no existe.
 */
const consultarPrecio = async (businessId, productId) => {
  const producto = await obtenerProductoActivo(businessId, productId);
  const business = await Business.findById(businessId);

  if (producto.price === null || producto.price === undefined) {
    return { productId: producto._id, priceAvailable: false };
  }

  return {
    productId: producto._id,
    price: producto.price,
    currency: resolverMoneda(producto, business),
    priceAvailable: true,
  };
};

module.exports = {
  crearProducto,
  obtenerProducto,
  obtenerProductoActivo,
  listarProductos,
  actualizarProducto,
  desactivarProducto,
  buscarProductos,
  consultarStock,
  consultarPrecio,
};
