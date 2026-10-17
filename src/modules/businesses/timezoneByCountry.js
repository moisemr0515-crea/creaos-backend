/**
 * Zona horaria por defecto de un negocio, derivada de su país (ISO 3166-1 alfa-2). Función PURA y universal: sin casos por
 * tenant. Mismo criterio que currencyByCountry.js: un país que no está en la tabla NO recibe una zona inventada (antes todos
 * nacían en 'America/Mexico_City'); devuelve null y quien necesite una zona decide (Estadísticas cae a UTC y lo avisa).
 * Países con varias zonas (p. ej. US) quedan fuera a propósito: no hay una sola respuesta correcta.
 *
 * Solo aplica al CREAR un negocio: no toca los documentos existentes.
 *
 * shortcut: tabla pequeña; ampliarla cuando haya negocios de otros países.
 */
const ZONA_POR_PAIS = Object.freeze({
  PE: 'America/Lima',
  MX: 'America/Mexico_City',
  CO: 'America/Bogota',
  AR: 'America/Argentina/Buenos_Aires',
  EC: 'America/Guayaquil',
  PA: 'America/Panama',
  SV: 'America/El_Salvador',
});

const zonaHorariaPorPais = (country) => {
  const codigo = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return ZONA_POR_PAIS[codigo] || null;
};

module.exports = { zonaHorariaPorPais, ZONA_POR_PAIS };
