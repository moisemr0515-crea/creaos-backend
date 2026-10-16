/**
 * Respaldo DIRECTO del PDF informativo (Fase 3, etapa C — P5). Sin Atlas ni embeddings: lee de Mongo.
 *
 * Cuándo se usa (tools search_products y search_business_knowledge):
 *   - search_products no encuentra el producto, o el catálogo está vacío ⇒ la IA puede responder con el documento.
 *   - el índice vectorial `chunk_vector_index` no existe, o la búsqueda semántica falla / no devuelve nada ⇒ degradar
 *     (sin error) a este respaldo.
 *
 * Precedencia (decisión del dueño): si el producto EXISTE en el catálogo, el catálogo manda en precio y stock; si no,
 * se puede usar el documento. La barrera `priceStockGuard` sigue descartando fragmentos que contradicen un producto real.
 * Nunca se envía este texto al lead como archivo: es conocimiento para responder.
 */
const BusinessDocumentChunk = require('./businessDocumentChunk.model');

const MAX_CHUNKS_RESPALDO = 5;
const MAX_CHUNKS_A_PUNTUAR = 300;
const MAX_TEXTO_RESPALDO = 4000;

const normalizar = (s) => String(s || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase();

const PALABRAS_VACIAS = new Set(['que', 'los', 'las', 'del', 'una', 'uno', 'con', 'por', 'para', 'como', 'hay', 'tienen', 'tiene', 'cual', 'cuales', 'quiero', 'sobre', 'esta', 'este', 'son', 'sus', 'mas', 'muy', 'pero', 'sin']);

const palabrasClave = (texto) => [...new Set(
  normalizar(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PALABRAS_VACIAS.has(w))
)];

/** PURA: ordena `chunks` por cuántas palabras de la consulta contienen (0 ⇒ se descarta). */
const rankearPorPalabras = (chunks, consulta, k = MAX_CHUNKS_RESPALDO) => {
  const claves = palabrasClave(consulta);
  if (!claves.length) return [];
  return chunks
    .map((c) => {
      const t = normalizar(c.text);
      return { chunk: c, puntaje: claves.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, k)
    .map((x) => ({ text: x.chunk.text, page: x.chunk.page ?? null }));
};

/**
 * @param {object} business  documento Business completo (viene del contexto del servidor, nunca del modelo)
 * @param {string} consulta  lo que preguntó el lead / lo que buscó la tool
 * @returns {Promise<null | {available:true, source:'pdf_informativo', chunks?:{text,page}[], text?:string, note:string}>}
 */
const obtenerRespaldoDocumento = async (business, consulta) => {
  if (!business?._id) return null;

  let chunks = [];
  try {
    const candidatos = await BusinessDocumentChunk.find({ business: business._id, active: true })
      .select('text page')
      .limit(MAX_CHUNKS_A_PUNTUAR)
      .lean();
    chunks = rankearPorPalabras(candidatos, consulta);
  } catch {
    chunks = []; // el respaldo nunca lanza: peor caso, usa el texto extraído
  }

  const texto = String(business.pdfExtractedText || business.pdfSummary || '').trim();
  if (!chunks.length && !texto) return null;

  return {
    available: true,
    source: 'pdf_informativo',
    ...(chunks.length ? { chunks } : {}),
    ...(texto ? { text: texto.slice(0, MAX_TEXTO_RESPALDO) } : {}),
    note: 'Texto del documento informativo del negocio (solo para responder; no es un archivo que se envía). '
      + 'Para un producto que SÍ está en el catálogo, el precio y el stock salen del catálogo, no de este texto.',
  };
};

module.exports = { obtenerRespaldoDocumento, rankearPorPalabras, palabrasClave, MAX_TEXTO_RESPALDO };
