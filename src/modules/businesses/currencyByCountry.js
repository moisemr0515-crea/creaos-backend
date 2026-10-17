/**
 * Moneda por defecto de un negocio, derivada de su país (ISO 3166-1 alfa-2). Función PURA y universal: sin casos por
 * tenant. Solo cubre las monedas que el selector de «Mi negocio» ofrece (PEN, USD, MXN, ARS, COP), para que el valor
 * por defecto siempre sea una opción que la pantalla sabe mostrar.
 *
 * Sin valores ocultos: un país que no está en la tabla NO recibe una moneda inventada (ni 'USD' ni 'MXN'); devuelve null y
 * la moneda queda sin definir hasta que el negocio la configure (la interfaz muestra «—»).
 *
 * shortcut: tabla pequeña; ampliar la tabla y el selector a la vez cuando haya negocios de otros países.
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

const monedaPorPais = (country) => {
  const codigo = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return MONEDA_POR_PAIS[codigo] || null;
};

module.exports = { monedaPorPais, MONEDA_POR_PAIS };
