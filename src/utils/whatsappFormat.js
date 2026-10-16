/**
 * Texto de la IA → formato de WhatsApp (Fase 3, etapa B, P1). Función PURA y universal: no depende de negocio, lead
 * ni teléfono. WhatsApp no interpreta Markdown: `[texto](url)` y `**negrita**` llegaban crudos al contacto.
 *
 *   [texto](url)   → texto: url      (si el texto es la propia URL, solo la URL)
 *   ![alt](url)    → url
 *   **a** / __a__  → *a*             (negrita de WhatsApp)
 *   # Título       → *Título*
 *   * ítem         → - ítem          (un `*` al inicio de línea sería negrita sin cerrar)
 * Lo que ya es válido en WhatsApp (`*negrita*`, `_cursiva_`, `- ítem`, URLs sueltas) no se toca.
 */
const aWhatsApp = (texto) => {
  if (typeof texto !== 'string' || !texto) return texto;
  return texto
    .replace(/!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_m, etiqueta, url) => {
      const limpia = etiqueta.trim();
      return !limpia || limpia === url ? url : `${limpia}: ${url}`;
    })
    .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')
    .replace(/__([^_\n]+?)__/g, '*$1*')
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '*$1*')
    .replace(/^([ \t]*)\*[ \t]+(?=\S)/gm, '$1- ');
};

module.exports = { aWhatsApp };
