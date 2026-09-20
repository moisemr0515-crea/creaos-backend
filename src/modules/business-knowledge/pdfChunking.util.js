// Bloque 3 de la auditoría Business Brain (§45-46, 20/sep/2026) — RAG del
// PDF. Función pura, sin I/O — divide el texto YA extraído (pdf-parse) en
// fragmentos chicos para embeddings/retrieval. Separado de
// business.service.js#generarResumenPdf() a propósito: ese resumen sigue
// operando sobre el texto truncado a 5000 caracteres (barato, siempre
// presente en el prompt); esto opera sobre el texto COMPLETO sin truncar
// (el sentido de RAG es cubrir justamente lo que no entra en el resumen).

// ~150-200 palabras (~200 tokens) — chico a propósito: K=5 candidatos
// (ver pdfIngestion.service.js) tienen que entrar cómodos en el prompt sin
// inflar tokens, mismo criterio que MAX_PDF_SUMMARY_LENGTH (800) en
// business.service.js.
const TAMANO_CHUNK = 800;
// Evita cortar una idea justo en el borde entre dos chunks consecutivos
// (ej. un encabezado de precio en un chunk y el valor en el siguiente).
const SOLAPE = 100;

// pdf-parse (ver business.service.js#subirPdf, comentario de textoLimpio)
// inserta este separador literal entre páginas: "-- 1 of 3 --". Se
// reutiliza EXACTAMENTE el mismo patrón acá, antes de que
// business.service.js lo limpie para el resumen — necesitamos los límites
// de página para poblar `page` en cada chunk, best-effort.
const PATRON_SEPARADOR_PAGINA = /--\s*(\d+)\s*of\s*\d+\s*--/g;

/**
 * Divide un bloque de texto (ya de UNA página, o el documento entero si no
 * se pudo determinar la página) en chunks de `tamano` caracteres con
 * `solape` de superposición. Nunca devuelve chunks vacíos/solo-espacios.
 */
function dividirTextoEnChunks(texto, { tamano = TAMANO_CHUNK, solape = SOLAPE } = {}) {
  const limpio = (texto || '').trim();
  if (!limpio) return [];

  const chunks = [];
  let inicio = 0;
  while (inicio < limpio.length) {
    const fin = Math.min(inicio + tamano, limpio.length);
    const fragmento = limpio.slice(inicio, fin).trim();
    if (fragmento) chunks.push(fragmento);
    if (fin === limpio.length) break;
    inicio = fin - solape;
  }
  return chunks;
}

/**
 * Separa el texto crudo de pdf-parse en segmentos por página, usando el
 * separador "-- N of M --" que el propio extractor inserta. Si no
 * encuentra ningún separador (PDF de una sola página, o un extractor que
 * no los generó), devuelve un único segmento con `page: null` — nunca
 * lanza, `page` es siempre best-effort (documento §46: "page si está
 * disponible").
 * @returns {{page: number|null, texto: string}[]}
 */
function separarPorPagina(textoCrudo) {
  const texto = textoCrudo || '';
  const matches = [...texto.matchAll(PATRON_SEPARADOR_PAGINA)];

  if (matches.length === 0) {
    return texto.trim() ? [{ page: null, texto }] : [];
  }

  const segmentos = [];
  // Texto ANTES del primer separador (si el documento no arranca justo con
  // uno) pertenece a la página 1 — pdf-parse inserta el separador ANTES
  // del contenido de la página que anuncia (no después), confirmado por
  // el propio nombre "-- 1 of 3 --" precediendo el contenido de la página 1.
  const antesDelPrimero = texto.slice(0, matches[0].index).trim();
  if (antesDelPrimero) segmentos.push({ page: 1, texto: antesDelPrimero });

  for (let i = 0; i < matches.length; i += 1) {
    const inicioContenido = matches[i].index + matches[i][0].length;
    const finContenido = i + 1 < matches.length ? matches[i + 1].index : texto.length;
    const contenido = texto.slice(inicioContenido, finContenido).trim();
    const numeroPagina = Number(matches[i][1]);
    if (contenido) segmentos.push({ page: Number.isFinite(numeroPagina) ? numeroPagina : null, texto: contenido });
  }

  return segmentos;
}

/**
 * Punto de entrada del pipeline de ingesta — separa por página y chunkea
 * cada página, devolviendo los chunks en orden con su `chunkIndex` y
 * `page` (best-effort) ya asignados. NO genera embeddings (eso vive en
 * pdfIngestion.service.js, que sí tiene I/O).
 * @returns {{chunkIndex: number, page: number|null, text: string}[]}
 */
function chunkearDocumento(textoCompleto, opciones = {}) {
  const segmentos = separarPorPagina(textoCompleto);
  const chunks = [];
  let chunkIndex = 0;

  for (const segmento of segmentos) {
    for (const fragmento of dividirTextoEnChunks(segmento.texto, opciones)) {
      chunks.push({ chunkIndex, page: segmento.page, text: fragmento });
      chunkIndex += 1;
    }
  }

  return chunks;
}

module.exports = { TAMANO_CHUNK, SOLAPE, dividirTextoEnChunks, separarPorPagina, chunkearDocumento };
