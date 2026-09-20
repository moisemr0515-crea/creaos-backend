const productService = require('../products/product.service');

// Bloque 3 de la auditoría Business Brain (§52/§54, 20/sep/2026) — barrera
// de código, no de prompt (Fase 2, punto 5: "convertir esto en una barrera
// real de código... nunca confiar en que el modelo elija bien"). Hallazgo
// de la Fase 1: el PDF de un negocio puede tener un precio DESACTUALIZADO
// (generarResumenPdf() le pide explícitamente al resumidor incluir
// precios si están en el documento) — si ese chunk llega al prompt, la
// única protección hoy es una instrucción de texto que el modelo puede
// ignorar. Esto lo hace estructuralmente imposible: si un chunk del PDF
// menciona precio/stock Y matchea un producto REAL del catálogo
// estructurado, se DESCARTA por completo antes de llegar a la tool — no
// se anota ni se marca "no autoritativo", porque eso seguiría poniendo el
// número viejo delante del modelo (mismo problema, un paso más lejos).
//
// Solo aplica a chunks del PDF — Policy/FAQ no listan precios por
// producto de la misma forma (el riesgo real encontrado en la Fase 1 es
// específico del PDF).

// Señales baratas de "esto menciona un precio o disponibilidad" — moneda
// (símbolo o código ISO) cerca de un número, o las palabras reales que
// usaría un PDF de ventas en español. Deliberadamente amplio (más falsos
// positivos que falsos negativos): el costo de descartar de más un chunk
// no ambiguo es bajo (K=5 igual trae otros candidatos, o el modelo cae a
// get_price/check_stock); el costo de dejar pasar un precio viejo es alto.
const PATRON_PRECIO_STOCK = /(\$|S\/\.?|USD|PEN|MXN|COP|CLP|ARS)\s*\d|\d+\s*(\$|S\/\.?|USD|PEN|MXN|COP|CLP|ARS)|precio|cuesta|cuestan|\bstock\b|disponib|agotad/i;

// Mismo umbral que product.service.js usa internamente para "hay un match
// real" en otros contextos de este proyecto — un matchScore normalizado
// (0-1, el mejor resultado del lote siempre en 1.0, ver
// product.service.js#buscarProductos()) por debajo de esto es demasiado
// débil para asumir que el chunk realmente habla de ESE producto.
const UMBRAL_MATCH_PRODUCTO = 0.3;

const mencionaPrecioOStock = (texto) => PATRON_PRECIO_STOCK.test(texto);

/**
 * Filtra chunks del PDF que mencionan precio/stock de un producto que
 * SÍ existe en el catálogo estructurado de este negocio — reusa
 * product.service.js#buscarProductos() tal cual (mismo índice de texto,
 * mismo filtro business+active:true, sin duplicar lógica). Nunca lanza:
 * un fallo buscando el producto se trata como "no hay match real", el
 * chunk se conserva (fail-open del lado del chunk, fail-closed del lado
 * del dato de precio — preferible perder un chunk de más a que una falla
 * de infraestructura bloquee todo el retrieval).
 * @param {{text: string, page: number|null, score: number}[]} chunks
 * @param {string} businessId
 */
const descartarClaimsDePrecioStockDesactualizados = async (chunks, businessId) => {
  if (!chunks.length) return chunks;

  const resultados = await Promise.all(
    chunks.map(async (chunk) => {
      if (!mencionaPrecioOStock(chunk.text)) return chunk;

      try {
        const matches = await productService.buscarProductos(businessId, chunk.text);
        const colisionaConProductoReal = matches.some((m) => m.matchScore >= UMBRAL_MATCH_PRODUCTO);
        return colisionaConProductoReal ? null : chunk;
      } catch {
        return chunk;
      }
    })
  );

  return resultados.filter(Boolean);
};

module.exports = { mencionaPrecioOStock, descartarClaimsDePrecioStockDesactualizados, UMBRAL_MATCH_PRODUCTO };
