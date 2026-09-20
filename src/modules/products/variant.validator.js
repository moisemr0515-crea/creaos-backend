const Joi = require('joi');

// Bloque 4 de la auditoría Business Brain (§61, 20/sep/2026). Mismo
// criterio que product.validator.js: `reservedStock` queda FUERA a
// propósito — sin flujo de reservas expuesto acá todavía (eso llega en el
// punto 2 de este bloque, con sus propias funciones dedicadas
// reservarStock/confirmarReserva/liberarReserva, nunca un edit manual
// directo del campo).
const variantFields = {
  sku: Joi.string().trim().min(1).max(60),
  // Objeto plano {color:'Rojo', talla:'M'} — el modelo lo persiste como
  // Map (ver variant.model.js), Mongoose hace la conversión sola.
  attributes: Joi.object().pattern(Joi.string().min(1), Joi.string().trim().min(1)).min(1),
  price: Joi.number().min(0).allow(null),
  currency: Joi.string().length(3).uppercase().allow(null),
  physicalStock: Joi.number().min(0),
  minimumStock: Joi.number().min(0),
  active: Joi.boolean(),
};

const createVariantSchema = Joi.object({
  ...variantFields,
  sku: variantFields.sku.required(),
  attributes: variantFields.attributes.required(),
});

const updateVariantSchema = Joi.object(variantFields).min(1);

module.exports = { createVariantSchema, updateVariantSchema };
