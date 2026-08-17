// Tarifas de OpenAI en USD por 1,000,000 de tokens.
// Actualizar manualmente si cambia el pricing — no hay API de OpenAI para consultarlo en runtime.
// gpt-4o quedó como modelo "legacy" tras el lanzamiento de la familia GPT-4.1/5.x (ene 2026),
// pero mantiene su tarifa original congelada para integraciones existentes (confirmado jul 2026).
const PRICING_PER_MILLION_TOKENS = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  // Agregado junto con PR39 (model routing, ai.service.js) — sin esta
  // entrada, cualquier mensaje guardado con metadata.model:'gpt-4o-mini'
  // caía a DEFAULT_PRICING (la tarifa de gpt-4o), sobrestimando el costo
  // real de los turnos ruteados al modelo barato. Último precio publicado
  // de OpenAI que tengo confirmado para gpt-4o-mini — verificar contra el
  // pricing vigente antes de confiar en el costo calculado para estos
  // mensajes si pasó mucho tiempo desde este commit.
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
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
