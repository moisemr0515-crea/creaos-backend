const OpenAI = require('openai');
const { OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL } = require('../config/env');

// Bloque 3 de la auditoría Business Brain (§45-56, 20/sep/2026) — RAG del
// PDF + semántica de FAQ/Policy. Sin librería de embeddings nueva a
// propósito (aprobado en Fase 2): el paquete `openai` ya está instalado y
// en uso (business.service.js#generarResumenPdf(), ai.service.js) — esto
// agrega la llamada a `.embeddings.create()` que hoy no existía en ningún
// lado del código (confirmado por grep exhaustivo en la Fase 1).
//
// Instancia propia (no un cliente compartido) — mismo criterio que el
// resto del proyecto: business.service.js/ai.service.js/mission.service.js
// ya instancian `new OpenAI(...)` cada uno por su lado, no hay un cliente
// centralizado que romper la convención introduciendo acá.
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Genera embeddings para uno o varios textos en una sola llamada — se usa
 * en modo batch para chunkear un PDF entero sin hacer una llamada HTTP por
 * chunk (pdfIngestion.service.js), y en modo single (`generarEmbedding`,
 * abajo) para una query de retrieval puntual.
 * @param {string[]} textos
 * @returns {Promise<number[][]>} un embedding por texto, en el mismo orden
 */
const generarEmbeddings = async (textos) => {
  if (!textos.length) return [];
  const respuesta = await openai.embeddings.create({ model: OPENAI_EMBEDDING_MODEL, input: textos });
  return respuesta.data.map((item) => item.embedding);
};

/** Conveniencia para un solo texto (ej. la query del lead en retrieval). */
const generarEmbedding = async (texto) => {
  const [embedding] = await generarEmbeddings([texto]);
  return embedding;
};

module.exports = { generarEmbeddings, generarEmbedding, openai };
