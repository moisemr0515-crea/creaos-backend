/**
 * ÚNICO formateador de importes para texto que ve la IA o una persona fuera de la app (prompts, misión del día, reportes).
 * Criterio del sistema: toda cantidad de dinero está en la moneda del NEGOCIO (`Business.currency`); nunca en la del
 * lead (`Lead.currency` ya no es fuente de verdad) y nunca en una moneda escrita a mano. Pura y sin locale, para que el
 * resultado sea idéntico en cualquier servidor.
 *
 *   formatearImporte(500, 'pen')   → "500 PEN"
 *   formatearImporte(500, null)    → "500"     (sin moneda no se inventa ninguna)
 *   formatearImporte(null, 'PEN')  → ""
 */
const normalizarMoneda = (moneda) => {
  const codigo = typeof moneda === 'string' ? moneda.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(codigo) ? codigo : '';
};

const formatearImporte = (valor, moneda) => {
  if (valor === null || valor === undefined || valor === '') return '';
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return '';
  const codigo = normalizarMoneda(moneda);
  return codigo ? `${numero} ${codigo}` : String(numero);
};

module.exports = { formatearImporte, normalizarMoneda };
