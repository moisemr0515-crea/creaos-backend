/**
 * Moneda por defecto de un negocio, derivada de su país (ISO 3166-1 alfa-2). Función PURA y universal: sin casos por
 * tenant. Solo cubre las monedas que el selector de «Mi negocio» ofrece (PEN, USD, MXN, ARS, COP), para que el valor
 * por defecto siempre sea una opción que la pantalla sabe mostrar.
 *
 * shortcut: tabla pequeña y país desconocido ⇒ 'USD' (moneda de referencia, no una elección del negocio); ampliar la
 * tabla y el selector a la vez cuando haya negocios de otros países.
 */
const MONEDA_POR_PAIS = Object.freeze({
  PE: 'PEN',
  MX: 'MXN',
  CO: 'COP',
  AR: 'ARS',
  US: 'USD',
  EC: 'USD', // economía dolarizada
  PA: 'USD',
  SV: 'USD',
});

const MONEDA_DE_REFERENCIA = 'USD';

const monedaPorPais = (country) => {
  const codigo = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return MONEDA_POR_PAIS[codigo] || MONEDA_DE_REFERENCIA;
};

module.exports = { monedaPorPais, MONEDA_POR_PAIS, MONEDA_DE_REFERENCIA };
