/**
 * Normalización de números de teléfono a E.164.
 *
 * Heurística deliberadamente simple (no usa una librería como
 * libphonenumber): confirmado contra datos reales de producción
 * (docs/implementation/fase-0a-contencion-report.md §3.1) que el 100% de
 * los números existentes son celulares peruanos de 9 dígitos, con o sin
 * código de país, con o sin "+", con o sin espacios/separadores.
 *
 * Asunción a confirmar si el proyecto suma negocios con leads de otros
 * países: el país por defecto asumido cuando el número tiene 9 dígitos
 * (sin código de país) es Perú (+51). Ver Implementation Blueprint §7.
 */

const DEFAULT_COUNTRY_CODE = '51';

/**
 * Normaliza un teléfono a formato E.164 (+<código país><número>).
 * No lanza error ante formatos no reconocidos — devuelve el valor original
 * sin tocar, para no bloquear guardados con datos atípicos (ver Lead.pre('save')).
 *
 * @param {string} raw
 * @param {string} [defaultCountryCode='51']
 * @returns {string}
 */
function normalizeToE164(raw, defaultCountryCode = DEFAULT_COUNTRY_CODE) {
  if (!raw || typeof raw !== 'string') return raw;

  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;

  // Ya viene con código de país (ej. 51922800127, 11 dígitos) → agregar "+".
  if (digits.length > 9) {
    return `+${digits}`;
  }

  // Celular local sin código de país (ej. 922800127, 9 dígitos) → prefijar default.
  if (digits.length === 9) {
    return `+${defaultCountryCode}${digits}`;
  }

  // Menos de 9 dígitos: dato incompleto/atípico, no se toca (no es un E.164 válido,
  // pero tampoco es responsabilidad de esta función inventar dígitos faltantes).
  return raw;
}

module.exports = { normalizeToE164, DEFAULT_COUNTRY_CODE };
