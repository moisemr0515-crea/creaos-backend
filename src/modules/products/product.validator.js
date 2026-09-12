const Joi = require('joi');
const { PRODUCT_TYPES } = require('./product.model');

// CREA Product Intelligence™ V1.0 — Etapa 3/10. Reglas de validación de la
// sección 11 del documento maestro ("Validación del Excel") aplicadas acá a
// la entrada MANUAL (alta/edición desde el panel) — el importador de
// Excel/CSV (Etapa 5) reusa estas mismas reglas fila por fila, no las
// reimplementa aparte.
//
// 2 campos del modelo quedan deliberadamente FUERA de estos schemas
// (Joi + `stripUnknown:true` en validateBody los descarta si el cliente los
// manda igual):
// - `reservedStock`: sin ningún flujo real de reservas en V1 (documento
//   maestro §3, fuera de alcance) — no tiene sentido exponerlo en el
//   formulario manual todavía, mejor no dar a entender que "hace algo" hoy.
// - `source`: SIEMPRE lo decide el service según el camino de creación
//   ('manual' acá, 'import' en la Etapa 5) — nunca algo que el cliente HTTP
//   pueda declarar.
const productFields = {
  sku: Joi.string().trim().min(1).max(60),
  name: Joi.string().trim().min(1).max(200),
  description: Joi.string().trim().max(1000).allow('', null),
  category: Joi.string().trim().max(100).allow('', null),
  brand: Joi.string().trim().max(100).allow('', null),
  productType: Joi.string().valid(...PRODUCT_TYPES),
  active: Joi.boolean(),
  // min(0) cubre "stock negativo"/"precio inválido" (documento §11) — un
  // valor negativo simplemente no pasa la validación, con mensaje Joi
  // estándar ("debe ser mayor o igual a 0"), igual que potentialValue en
  // lead.validator.js.
  price: Joi.number().min(0).allow(null),
  // Mismo criterio exacto que currency en lead.validator.js — ISO 4217 de 3
  // letras, sin lista fija de monedas válidas (igual que Business.currency,
  // que tampoco restringe a un enum).
  currency: Joi.string().length(3).uppercase().allow(null),
  trackInventory: Joi.boolean(),
  physicalStock: Joi.number().min(0),
  minimumStock: Joi.number().min(0),
  keywords: Joi.array().items(Joi.string().trim()),
  synonyms: Joi.array().items(Joi.string().trim()),
};

const createProductSchema = Joi.object({
  ...productFields,
  sku: productFields.sku.required(),
  name: productFields.name.required(),
});

const updateProductSchema = Joi.object(productFields).min(1);

const listProductsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().max(200).optional().allow(''),
  category: Joi.string().max(100).optional().allow(''),
  active: Joi.boolean().optional(),
});

module.exports = {
  createProductSchema,
  updateProductSchema,
  listProductsSchema,
};
