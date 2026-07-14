// Tarifas de OpenAI en USD por 1,000,000 de tokens.
// Actualizar manualmente si cambia el pricing — no hay API de OpenAI para consultarlo en runtime.
// gpt-4o quedó como modelo "legacy" tras el lanzamiento de la familia GPT-4.1/5.x (ene 2026),
// pero mantiene su tarifa original congelada para integraciones existentes (confirmado jul 2026).
const PRICING_PER_MILLION_TOKENS = {
  'gpt-4o': { input: 2.50, output: 10.00 },
};

// Fallback si el modelo configurado no está en la tabla de arriba.
const DEFAULT_PRICING = { input: 2.50, output: 10.00 };

const getPricing = (model) => PRICING_PER_MILLION_TOKENS[model] || DEFAULT_PRICING;

// Tarifa combinada, usada solo para mensajes históricos sin desglose prompt/completion guardado.
const getBlendedRate = (model) => {
  const { input, output } = getPricing(model);
  return (input + output) / 2;
};

module.exports = { PRICING_PER_MILLION_TOKENS, getPricing, getBlendedRate };
