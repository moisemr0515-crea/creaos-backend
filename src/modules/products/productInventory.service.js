const mongoose = require('mongoose');
const Product = require('./product.model');
const Variant = require('./variant.model');
const StockReservation = require('./stockReservation.model');
const productService = require('./product.service');
const { AppError } = require('../../middleware/error.middleware');
const { STOCK_RESERVATION_TTL_MINUTES } = require('../../config/env');
const logger = require('../../utils/logger');

// Bloque 4 de la auditoría Business Brain (§57-61, 20/sep/2026) —
// Inventario avanzado. Archivo HERMANO de product.service.js (Fase 2,
// punto 1: NO es una capa/InventoryService que envuelve al otro, mismo
// criterio que knowledgeRetrieval.service.js/priceStockGuard.service.js
// conviven como hermanos en business-knowledge/). Agrupa lo nuevo de este
// bloque: variantes y reservas — consultarStock/consultarPrecio/
// buscarProductos/obtenerProductoActivo se quedan en product.service.js,
// sin mudar sus imports existentes en ai/tools/index.js y
// priceStockGuard.service.js.

const verificarSkuDuplicado = async (businessId, sku, { excluirVarianteId } = {}) => {
  const filtro = { business: businessId, sku: sku.trim().toUpperCase() };
  if (excluirVarianteId) filtro._id = { $ne: excluirVarianteId };

  const existente = await Variant.findOne(filtro);
  if (existente) {
    throw new AppError(`Ya existe una variante con el SKU "${existente.sku}" en este negocio`, 409);
  }
};

/**
 * Crea una variante para un producto — el producto pasa a hasVariants:true
 * automáticamente en la PRIMERA variante que se le crea (evita un paso
 * manual aparte de "activar variantes" antes de poder cargar la primera).
 * Exige al menos 1 atributo (documento §61: una variante sin ningún
 * atributo no tiene sentido — sería un segundo SKU idéntico al padre).
 */
const crearVariante = async (businessId, productId, data) => {
  const producto = await Product.findOne({ _id: productId, business: businessId });
  if (!producto) throw new AppError('Producto no encontrado', 404);

  if (!data.attributes || Object.keys(data.attributes).length === 0) {
    throw new AppError('Una variante necesita al menos un atributo (ej. color, talla)', 400);
  }

  await verificarSkuDuplicado(businessId, data.sku);

  const variante = await Variant.create({
    ...data,
    business: businessId,
    product: producto._id,
  });

  if (!producto.hasVariants) {
    producto.hasVariants = true;
    await producto.save();
  }

  return variante;
};

/** Sin filtro de active — vista de administración, mismo criterio que obtenerProducto() en product.service.js. */
const listarVariantes = async (businessId, productId) => {
  const producto = await Product.findOne({ _id: productId, business: businessId });
  if (!producto) throw new AppError('Producto no encontrado', 404);

  return Variant.find({ business: businessId, product: productId }).sort({ createdAt: 1 });
};

const obtenerVariante = async (businessId, productId, variantId) => {
  const variante = await Variant.findOne({ _id: variantId, business: businessId, product: productId });
  if (!variante) throw new AppError('Variante no encontrada', 404);
  return variante;
};

const actualizarVariante = async (businessId, productId, variantId, data) => {
  const variante = await obtenerVariante(businessId, productId, variantId);

  if (data.sku !== undefined && data.sku.trim().toUpperCase() !== variante.sku) {
    await verificarSkuDuplicado(businessId, data.sku, { excluirVarianteId: variante._id });
  }

  Object.assign(variante, data);
  await variante.save();
  return variante;
};

/**
 * "Eliminar" una variante es SIEMPRE desactivarla — mismo criterio que
 * desactivarProducto() (nunca borrar, documento §9: trazabilidad).
 */
const desactivarVariante = async (businessId, productId, variantId) => {
  const variante = await obtenerVariante(businessId, productId, variantId);
  variante.active = false;
  await variante.save();
  return variante;
};

// Reservas de stock (§59, 20/sep/2026) — ampliación consciente de alcance
// respecto al documento maestro (§42, V1.5). Ciclo de vida:
// active → confirmed (venta real, ver Fase 3 punto 3) | released (el lead
// no confirmó) | expired (el sweep de BullMQ la vence sola, ver
// stockReservationSweep.worker.js).
//
// `session.withTransaction()` con el MISMO fallback exacto que
// auth.service.js#registrar()/pdfIngestion.service.js#ejecutarCutover():
// standalone Mongo (dev/test local) no soporta transacciones, cae a
// operaciones secuenciales. En producción (Atlas, replica set real) esa
// rama nunca corre.
const conSesionTransaccional = async (ejecutar) => {
  const session = await mongoose.startSession();
  try {
    let resultado;
    await session.withTransaction(async () => {
      resultado = await ejecutar(session);
    });
    return resultado;
  } catch (txError) {
    if (
      txError.message?.includes('replica set') ||
      txError.message?.includes('Transaction numbers') ||
      txError.codeName === 'IllegalOperation'
    ) {
      return ejecutar(null);
    }
    throw txError;
  } finally {
    await session.endSession();
  }
};

/**
 * Validación compartida de un item de movimiento de stock (reservar O
 * descontar directo) — un único punto de resolución para "¿este
 * producto/variante puede moverse en esta cantidad?" (mismo criterio de "no
 * duplicar la lógica de branching" que resolverVariante()/
 * resolverVariantesParaSeleccion() en product.service.js). Usado por
 * reservarStock() y por descontarStockDirecto() (cierre de venta, Fase 3
 * punto 3).
 */
const validarItemDeMovimientoStock = async (businessId, { productId, variantId, quantity }) => {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AppError('quantity debe ser un entero mayor a 0', 400);
  }

  const producto = await productService.obtenerProductoActivo(businessId, productId);
  if (!producto.trackInventory) {
    throw new AppError('Este producto no tiene control de inventario activado', 400);
  }
  if (producto.hasVariants && !variantId) {
    throw new AppError('Este producto tiene variantes: se requiere variantId', 400);
  }
  if (variantId) {
    // Valida pertenencia a este producto/negocio y que esté activa — mismo
    // resolverVariante() que ya usa product.service.js#consultarStock().
    await productService.resolverVariante(businessId, productId, variantId);
  }

  return producto;
};

/**
 * Aparta stock para un lead durante la conversación — NO descuenta
 * physicalStock todavía (eso pasa recién en confirmarReserva(), cuando la
 * venta es real). El `$inc` está condicionado con `$expr` en el MISMO
 * findOneAndUpdate atómico que hace la resta: evita que dos reservas
 * concurrentes sobre el mismo producto/variante lean "hay stock" antes de
 * que ninguna de las dos lo haya escrito todavía (race condition clásica de
 * leer-y-luego-escribir en 2 pasos separados).
 */
const reservarStock = async (businessId, { productId, variantId, quantity, leadId, createdBy } = {}) => {
  const producto = await validarItemDeMovimientoStock(businessId, { productId, variantId, quantity });

  const Modelo = variantId ? Variant : Product;
  const filtroId = variantId || productId;

  return conSesionTransaccional(async (session) => {
    const opts = session ? { session } : {};

    const fuenteActualizada = await Modelo.findOneAndUpdate(
      {
        _id: filtroId,
        business: businessId,
        $expr: { $gte: [{ $subtract: ['$physicalStock', '$reservedStock'] }, quantity] },
      },
      { $inc: { reservedStock: quantity } },
      { new: true, ...opts }
    );

    if (!fuenteActualizada) {
      throw new AppError('Stock insuficiente para reservar la cantidad solicitada', 409);
    }

    const [reserva] = await StockReservation.create(
      [
        {
          business: businessId,
          product: producto._id,
          variant: variantId || null,
          lead: leadId || null,
          quantity,
          status: 'active',
          expiresAt: new Date(Date.now() + STOCK_RESERVATION_TTL_MINUTES * 60 * 1000),
          createdBy: createdBy || null,
        },
      ],
      opts
    );

    return reserva;
  });
};

/**
 * Descuento DIRECTO de physicalStock sin pasar por una reserva previa —
 * usado por el cierre de venta (Fase 3, punto 3, POST /leads/:id/close-sale)
 * cuando el item vendido no tenía ninguna reserva activa asociada (el lead
 * nunca pasó por reservarStock durante la conversación). Mismo `$expr`+
 * `$inc` atómico que reservarStock(), pero descuenta directo de
 * physicalStock — nunca toca reservedStock, porque acá no hubo nada
 * apartado que liberar.
 *
 * Acepta `opts` (típicamente `{session}`) para participar en la MISMA
 * transacción que el llamador — lead.service.js#cerrarVenta() ya abre su
 * propia transacción externa y llama esto una vez por item vendido; no
 * abre una transacción propia acá (a diferencia de reservarStock()) para
 * que el cierre completo (Lead + todos sus items) sea atómico de punta a
 * punta.
 */
const descontarStockDirecto = async (businessId, { productId, variantId, quantity }, opts = {}) => {
  await validarItemDeMovimientoStock(businessId, { productId, variantId, quantity });

  const Modelo = variantId ? Variant : Product;
  const filtroId = variantId || productId;

  const actualizado = await Modelo.findOneAndUpdate(
    {
      _id: filtroId,
      business: businessId,
      $expr: { $gte: [{ $subtract: ['$physicalStock', '$reservedStock'] }, quantity] },
    },
    { $inc: { physicalStock: -quantity } },
    { new: true, ...opts }
  );

  if (!actualizado) {
    throw new AppError('Stock insuficiente para completar la venta', 409);
  }
  return actualizado;
};

/**
 * Transición genérica active→{estadoDestino} de una reserva puntual, con el
 * ajuste de stock que corresponda — un único punto de resolución para
 * confirmar/liberar/expirar (mismo criterio de "no duplicar la lógica de
 * branching" que resolverVariante()/resolverVariantesParaSeleccion() en
 * product.service.js).
 *
 * Atómico y CONDICIONADO a `status:'active'` en el propio findOneAndUpdate
 * — idempotente: si la reserva ya está en `estadoDestino` (ej. un reintento
 * de red que reenvía la misma confirmación), no vuelve a tocar el stock, es
 * un no-op exitoso. Si está en cualquier OTRO estado (ej. tratar de
 * confirmar una que ya se liberó), es un conflicto real → 409.
 */
const transicionarReservaConSesion = async (businessId, reservationId, { estadoDestino, timestampField, incluirPhysicalStock = false }, session) => {
  const opts = session ? { session } : {};

  const reserva = await StockReservation.findOneAndUpdate(
    { _id: reservationId, business: businessId, status: 'active' },
    { $set: { status: estadoDestino, [timestampField]: new Date() } },
    { new: true, ...opts }
  );

  if (!reserva) {
    const existente = await StockReservation.findOne({ _id: reservationId, business: businessId }, null, opts);
    if (!existente) throw new AppError('Reserva no encontrada', 404);
    if (existente.status === estadoDestino) return existente; // idempotente
    throw new AppError(`La reserva ya no está activa (estado actual: ${existente.status})`, 409);
  }

  const Modelo = reserva.variant ? Variant : Product;
  const incremento = { reservedStock: -reserva.quantity };
  if (incluirPhysicalStock) incremento.physicalStock = -reserva.quantity;

  await Modelo.updateOne({ _id: reserva.variant || reserva.product }, { $inc: incremento }, opts);

  return reserva;
};

/**
 * Envoltorio público: sin `opts.session`, abre su propia transacción
 * (conSesionTransaccional) — uso standalone (sweep, llamada directa a
 * confirmar/liberar). CON `opts.session`, participa en la transacción del
 * llamador sin abrir una propia — Mongo no soporta transacciones anidadas
 * en sesiones distintas, así que lead.service.js#cerrarVenta() (que ya
 * abre su propia transacción externa) pasa su `session` acá en vez de
 * dejar que esto arranque una segunda transacción independiente, que
 * rompería la atomicidad del cierre completo.
 */
const transicionarReserva = (businessId, reservationId, config, { session } = {}) =>
  session
    ? transicionarReservaConSesion(businessId, reservationId, config, session)
    : conSesionTransaccional((s) => transicionarReservaConSesion(businessId, reservationId, config, s));

/**
 * Venta real confirmada — descuenta physicalStock Y reservedStock (el
 * stock reservado se convierte en stock efectivamente vendido). Ver Fase 3
 * punto 3 (POST /leads/:id/close-sale) para el flujo completo que dispara
 * esto.
 */
const confirmarReserva = (businessId, reservationId, opts) =>
  transicionarReserva(businessId, reservationId, {
    estadoDestino: 'confirmed',
    timestampField: 'confirmedAt',
    incluirPhysicalStock: true,
  }, opts);

/** El lead no confirmó — devuelve el stock apartado, physicalStock nunca se tocó. */
const liberarReserva = (businessId, reservationId, opts) =>
  transicionarReserva(businessId, reservationId, {
    estadoDestino: 'released',
    timestampField: 'releasedAt',
  }, opts);

/** Vencimiento individual — mismo ajuste de stock que liberarReserva(), estado final distinto. */
const expirarReservaPuntual = (businessId, reservationId, opts) =>
  transicionarReserva(businessId, reservationId, {
    estadoDestino: 'expired',
    timestampField: 'releasedAt',
  }, opts);

/**
 * Barrido periódico (stockReservationSweep.worker.js, job repetible de
 * BullMQ) — vence toda reserva `active` cuyo `expiresAt` ya pasó. Cada
 * reserva se procesa en su propia transacción puntual (expirarReservaPuntual);
 * una que falla (ej. alguien la confirmó/liberó justo entre el find() de
 * abajo y su transición) no debe tumbar el resto del barrido — mismo
 * criterio fail-soft que automationSweepWorker#processSweepJob().
 */
const liberarReservasVencidas = async () => {
  const ahora = new Date();
  const vencidas = await StockReservation.find({ status: 'active', expiresAt: { $lte: ahora } })
    .select('_id business')
    .lean();

  let totalLiberadas = 0;
  for (const { _id, business } of vencidas) {
    try {
      const resultado = await expirarReservaPuntual(business, _id);
      if (resultado) totalLiberadas++;
    } catch (err) {
      logger.warn(`[productInventoryService] no se pudo expirar la reserva ${_id}: ${err.message}`);
    }
  }

  logger.info(`[productInventoryService] barrido de reservas: ${vencidas.length} vencidas, ${totalLiberadas} liberadas`);
  return { totalVencidas: vencidas.length, totalLiberadas };
};

module.exports = {
  crearVariante,
  listarVariantes,
  obtenerVariante,
  actualizarVariante,
  desactivarVariante,
  reservarStock,
  descontarStockDirecto,
  confirmarReserva,
  liberarReserva,
  liberarReservasVencidas,
};
