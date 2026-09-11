/**
 * Escapa los caracteres especiales de regex de un string arbitrario para
 * que pueda usarse de forma segura como literal dentro de `new RegExp(...)`
 * — sin esto, un término de búsqueda con caracteres como `.`, `*`, `+`,
 * `(`, `)`, `[`, `]` puede romper la query (regex inválida) o, con un input
 * armado a propósito, degenerar en un patrón costoso (riesgo de ReDoS).
 *
 * Reglas: `$&` en el reemplazo referencia el match completo — cada
 * caracter especial se antepone con `\`, dejándolo literal.
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
