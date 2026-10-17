const Sale = require('./sale.model');
const Lead = require('../leads/lead.model');
const Business = require('../businesses/business.model');
const { normalizarMoneda } = require('../../utils/money');
const { AppError } = require('../../middleware/error.middleware');

/**
 * Registra una venta. `businessId` siempre sale del token (nunca del cuerpo) y el lead se valida contra ESE negocio: un id
 * de otro negocio da 404. La moneda es la del negocio al momento de registrar (sin moneda válida queda null: no se inventa).
 *
 * `session` es opcional: cerrarVenta() la pasa para que la venta entre en la MISMA transacción que el cierre del lead.
 * Un `ref` repetido en el mismo negocio se rechaza con 409 (índice único parcial), así un reintento no duplica la venta.
 */
const crearVenta = async (businessId, { leadId, amount, origin, status, closedAt = null, ref }, { session } = {}) => {
  const opts = session ? { session } : {};

  const lead = await Lead.findOne({ _id: leadId, business: businessId }, '_id', opts);
  if (!lead) throw new AppError('Lead no encontrado', 404);

  const negocio = await Business.findById(businessId, 'currency', opts);
  const currency = normalizarMoneda(negocio?.currency) || null;

  try {
    const [venta] = await Sale.create(
      [{ business: businessId, lead: leadId, amount, currency, origin, status, closedAt, ...(ref ? { ref } : {}) }],
      opts
    );
    return venta;
  } catch (error) {
    if (error?.code === 11000) throw new AppError('Ya existe una venta con esa referencia en este negocio', 409);
    throw error;
  }
};

/**
 * Borra una venta recién creada. Solo para deshacer un cierre que falló a mitad cuando NO hubo transacción (Mongo standalone):
 * con transacción Mongo revierte solo. No es una "anulación" de ventas reales (eso no existe todavía).
 */
const descartarVenta = async (businessId, ventaId) => Sale.deleteOne({ _id: ventaId, business: businessId });

module.exports = { crearVenta, descartarVenta };
