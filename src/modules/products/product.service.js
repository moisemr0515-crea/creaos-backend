const Product = require('./product.model');
const Variant = require('./variant.model');
const Business = require('../businesses/business.model');
const { AppError } = require('../../middleware/error.middleware');
const { subirBuffer, cloudinary } = require('../../utils/cloudinary');
const logger = require('../../utils/logger');

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
// Bloque 4 (§61, 20/sep/2026) — resuelve las variantes ACTIVAS de un
// producto en el shape chico que necesita la IA para elegir/mostrar sin
// una segunda ronda de tools — usado tanto por buscarProductos() (acá
// abajo) como por consultarStock()/consultarPrecio() cuando hace falta
// pedirle al modelo que aclare CUÁL variante (needsVariantSelection).
// `attributes` es un Map de Mongoose en el documento hidratado, pero
// `.lean()` ya lo devuelve como objeto plano (no hace falta
// Object.fromEntries acá — probarlo con datos reales de Mongo, no
// solo en memoria, fue lo que reveló que un Map de Mongoose con .lean()
// NO es iterable como Map.entries()).
const resolverVariantesParaSeleccion = async (businessId, productId) => {
  const variantes = await Variant.find({ business: businessId, product: productId, active: true }).lean();
  return variantes.map((v) => ({
    variantId: v._id,
    sku: v.sku,
    attributes: v.attributes || {},
    price: v.price,
    availableStock: v.physicalStock - v.reservedStock,
  }));
};

/**
 * Resuelve una variante puntual, scoped a negocio+producto+activa — mismo
 * criterio de aislamiento que obtenerProductoActivo(): nunca confía en un
 * variantId que no pertenezca a ESTE producto de ESTE negocio.
 */
const resolverVariante = async (businessId, productId, variantId) => {
  const variante = await Variant.findOne({ _id: variantId, business: businessId, product: productId, active: true });
  if (!variante) throw new AppError('Variante no encontrada', 404);
  return variante;
};

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

  return Promise.all(resultados.map(async (p) => {
    const item = {
      productId: p._id,
      sku: p.sku,
      name: p.name,
      price: p.price,
      currency: resolverMoneda(p, business),
      trackInventory: p.trackInventory,
      availableStock: p.physicalStock - p.reservedStock,
      active: p.active,
      matchScore: Math.round((p.score / scoreMax) * 100) / 100,
    };
    // Bloque 4 (§61) — con variantes, el resultado trae de una sola vez
    // cada combinación con su propio precio/stock (ej. "Rojo M: $50,
    // disponible / Azul L: agotado"), sin una segunda ronda de tools —
    // mismo criterio de "no meter todo el catálogo" (documento §19): son
    // como mucho las variantes de ESTE producto puntual, no del catálogo entero.
    if (p.hasVariants) {
      item.hasVariants = true;
      item.variants = await resolverVariantesParaSeleccion(businessId, p._id);
    }
    return item;
  }));
};

/**
 * check_stock() — documento maestro §17. `trackInventory:false` responde
 * `availability:'NOT_TRACKED'` en vez de cualquier número de stock — así
 * la IA nunca puede interpretar un servicio sin seguimiento de inventario
 * como "agotado" solo porque physicalStock quedó en su default (0).
 *
 * Bloque 4 (§61, 20/sep/2026) — variant-aware, UNA sola ramificación acá
 * (Fase 2, punto 2: "una sola función de resolución, no duplicar la
 * lógica"): si el producto tiene variantes y no vino `variantId`, devuelve
 * `needsVariantSelection` (mismo patrón `needsClarification` que ya usa
 * resolverConocimiento() del Bloque 3 — pedirle al modelo que aclare, no
 * que adivine) en vez de un número ambiguo. `trackInventory` sigue siendo
 * SOLO de Product (nunca por variante) — no tendría sentido real que unas
 * variantes de un mismo producto se sigan y otras no.
 */
const consultarStock = async (businessId, productId, variantId) => {
  const producto = await obtenerProductoActivo(businessId, productId);

  if (!producto.trackInventory) {
    return { productId: producto._id, trackInventory: false, availability: 'NOT_TRACKED' };
  }

  if (producto.hasVariants && !variantId) {
    return { productId: producto._id, needsVariantSelection: true, variants: await resolverVariantesParaSeleccion(businessId, producto._id) };
  }

  const fuente = producto.hasVariants ? await resolverVariante(businessId, producto._id, variantId) : producto;
  const availableStock = fuente.physicalStock - fuente.reservedStock;

  const resultado = {
    productId: producto._id,
    trackInventory: true,
    physicalStock: fuente.physicalStock,
    reservedStock: fuente.reservedStock,
    availableStock,
    inStock: availableStock > 0,
    lowStock: availableStock > 0 && availableStock <= fuente.minimumStock,
  };
  if (producto.hasVariants) resultado.variantId = fuente._id;
  return resultado;
};

/**
 * get_price() — documento maestro §18. `priceAvailable:false` cuando el
 * producto no tiene precio cargado — "la IA debe preguntar/derivar, nunca
 * inventar" un precio que no existe.
 *
 * Bloque 4 (§61) — mismo criterio variant-aware que consultarStock().
 * `Variant.price` null cae al `Product.price` padre (mismo patrón de
 * fallback que ya usa resolverMoneda() con business.currency).
 */
const consultarPrecio = async (businessId, productId, variantId) => {
  const producto = await obtenerProductoActivo(businessId, productId);
  const business = await Business.findById(businessId);

  if (producto.hasVariants && !variantId) {
    return { productId: producto._id, needsVariantSelection: true, variants: await resolverVariantesParaSeleccion(businessId, producto._id) };
  }

  const fuente = producto.hasVariants ? await resolverVariante(businessId, producto._id, variantId) : producto;
  const precio = fuente.price ?? producto.price;

  if (precio === null || precio === undefined) {
    return { productId: producto._id, priceAvailable: false };
  }

  const resultado = {
    productId: producto._id,
    price: precio,
    currency: fuente.currency || resolverMoneda(producto, business),
    priceAvailable: true,
  };
  if (producto.hasVariants) resultado.variantId = fuente._id;
  return resultado;
};

/**
 * Bloque 2 de la auditoría Business Brain (§37-39, 20/sep/2026) — sube una
 * foto NUEVA a Cloudinary y la agrega a Product.mediaAssets. Nace directo
 * type:'authenticated' (nunca una URL pública): a diferencia de logo/photos
 * de Business (Bloque 1), acá no hay un rollout en pasos que hacer — es
 * 100% nuevo, sin datos viejos que convivan.
 *
 * isPrimary: se marca si se pide explícito, o si esta es la PRIMERA foto
 * del producto — evita quedar con fotos cargadas pero ninguna marcada
 * principal (productAssetAccess.service.js#resolverFotoPrincipal() ya cae
 * a "la primera del array" en ese caso, pero dejarlo explícito acá es más
 * claro que depender de ese fallback implícito). Marcar una foto nueva
 * como principal desmarca cualquier otra — invariante del modelo (a lo
 * sumo 1), reforzada acá y validada de nuevo por el pre-validate hook.
 */
const agregarFotoProducto = async (businessId, productId, file, { caption, isPrimary } = {}) => {
  const producto = await obtenerProducto(businessId, productId);

  const resultado = await subirBuffer(file.buffer, {
    folder: `creaos/products/${businessId}/${productId}/photos`,
    resource_type: 'image',
    type: 'authenticated',
  });

  const marcarPrincipal = isPrimary === true || producto.mediaAssets.length === 0;
  if (marcarPrincipal) {
    producto.mediaAssets.forEach((m) => { m.isPrimary = false; });
  }

  producto.mediaAssets.push({
    publicId: resultado.public_id,
    resourceType: resultado.resource_type,
    caption: caption || null,
    isPrimary: marcarPrincipal,
    order: producto.mediaAssets.length,
  });

  await producto.save();
  return producto;
};

/**
 * Borra una foto puntual (Cloudinary, best-effort, + Product.mediaAssets).
 * Si la foto borrada era la principal y quedan otras, promueve la primera
 * restante (por `order`) — mismo motivo que el auto-marcado de
 * agregarFotoProducto(): nunca dejar fotos cargadas sin ninguna principal.
 */
const eliminarFotoProducto = async (businessId, productId, mediaId) => {
  const producto = await obtenerProducto(businessId, productId);

  const foto = producto.mediaAssets.id(mediaId);
  if (!foto) throw new AppError('Foto no encontrada', 404);

  const eraPrincipal = foto.isPrimary;

  try {
    await cloudinary.uploader.destroy(foto.publicId, { resource_type: foto.resourceType, type: 'authenticated' });
  } catch (error) {
    logger.warn(`Error al borrar foto de producto de Cloudinary (${foto.publicId}): ${error.message}`);
  }

  foto.deleteOne();

  if (eraPrincipal && producto.mediaAssets.length > 0) {
    const [primeraRestante] = [...producto.mediaAssets].sort((a, b) => (a.order || 0) - (b.order || 0));
    primeraRestante.isPrimary = true;
  }

  await producto.save();
  return producto;
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
  agregarFotoProducto,
  eliminarFotoProducto,
  // Bloque 4 (§61, 20/sep/2026) — exportadas para que
  // productInventory.service.js (crearVariante/reservarStock/etc.) las
  // reuse sin duplicar la resolución de variante.
  resolverVariante,
  resolverVariantesParaSeleccion,
};
