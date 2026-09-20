/**
 * Infraestructura one-off — Bloque 3 de la auditoría Business Brain
 * (§51/§53, 20/sep/2026): crea los índices de Atlas Vector Search que
 * necesita el retrieval semántico (knowledgeRetrieval.service.js). NO es
 * una migración de datos — no toca ningún documento, solo declara índices
 * a nivel de colección en Atlas. Idempotente: si un índice ya existe con
 * ese nombre, lo saltea (createSearchIndex() en un índice existente
 * lanzaría "Duplicate Index").
 *
 * Confirmado empíricamente (Fase 1, 20/sep/2026) que este cluster Atlas
 * soporta Vector Search de forma nativa — sin esto no haría falta ningún
 * paso de infraestructura nueva más allá de esto.
 *
 * 3 índices, uno por colección:
 *   - businessdocumentchunks: vector sobre `embedding` + filtro sobre
 *     `business`/`active` (retrieval de chunks del PDF).
 *   - policies / faqs: vector sobre `embedding` + filtro sobre
 *     `business`/`status`/`effectiveFrom`/`effectiveUntil` — LOS MISMOS
 *     campos que construirFiltroElegible() ya usa en
 *     knowledgeRetrieval.service.js, para poder pasar exactamente ese
 *     mismo filtro como `filter` de $vectorSearch sin duplicar lógica.
 *
 * Uso:
 *   node scripts/ensure-atlas-vector-indexes.js           # dry-run, solo lista qué falta
 *   node scripts/ensure-atlas-vector-indexes.js --confirm # crea los que falten
 */
const DIMENSIONES_EMBEDDING = 1536; // text-embedding-3-small (ver src/utils/embeddings.js)

const DEFINICIONES = [
  {
    coleccion: 'businessdocumentchunks',
    nombreIndice: 'chunk_vector_index',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: DIMENSIONES_EMBEDDING, similarity: 'cosine' },
        { type: 'filter', path: 'business' },
        { type: 'filter', path: 'active' },
      ],
    },
  },
  {
    coleccion: 'policies',
    nombreIndice: 'policy_vector_index',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: DIMENSIONES_EMBEDDING, similarity: 'cosine' },
        { type: 'filter', path: 'business' },
        { type: 'filter', path: 'status' },
        { type: 'filter', path: 'effectiveFrom' },
        { type: 'filter', path: 'effectiveUntil' },
        // knowledgeRetrieval.service.js#buscarConocimiento() SIEMPRE arma
        // el filtro estructural con un $or sobre estos 3 campos de scope
        // (nunca se llama a $vectorSearch sin ellos) — sin declararlos acá
        // como filter, Atlas rechaza la query entera con "needs to be
        // indexed as filter" (bug real encontrado 20/sep/2026 al verificar
        // esto empíricamente contra producción, ver docs/business-brain-audit/).
        { type: 'filter', path: 'scope.appliesToAll' },
        { type: 'filter', path: 'scope.productIds' },
        { type: 'filter', path: 'scope.channelIds' },
      ],
    },
  },
  {
    coleccion: 'faqs',
    nombreIndice: 'faq_vector_index',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: DIMENSIONES_EMBEDDING, similarity: 'cosine' },
        { type: 'filter', path: 'business' },
        { type: 'filter', path: 'status' },
        { type: 'filter', path: 'effectiveFrom' },
        { type: 'filter', path: 'effectiveUntil' },
        // FAQ.scope V1 no tiene productIds propio (ver knowledgeRetrieval.service.js) — solo estos 2.
        { type: 'filter', path: 'scope.appliesToAll' },
        { type: 'filter', path: 'scope.channelIds' },
      ],
    },
  },
];

/** Compara por `path` (orden-independiente) — no por igualdad profunda literal del objeto completo. */
const mismaDefinicion = (definicionActual, definicionDeseada) => {
  const normalizar = (fields) => [...fields].map((f) => `${f.type}:${f.path}`).sort().join('|');
  return normalizar(definicionActual?.fields || []) === normalizar(definicionDeseada.fields);
};

/**
 * @param {import('mongodb').Db} db
 * @param {{confirm?: boolean}} [opts]
 */
async function run(db, { confirm = false } = {}) {
  const resultados = [];

  for (const { coleccion, nombreIndice, definition } of DEFINICIONES) {
    const collection = db.collection(coleccion);
    const existentes = await collection.listSearchIndexes().toArray().catch(() => []);
    const existente = existentes.find((idx) => idx.name === nombreIndice);

    if (existente && mismaDefinicion(existente.latestDefinition, definition)) {
      console.log(`✅ ${coleccion}.${nombreIndice} ya existe con la definición correcta — nada que hacer.`);
      resultados.push({ coleccion, nombreIndice, accion: 'ya_existia' });
      continue;
    }

    if (existente) {
      if (!confirm) {
        console.log(`🔎 ${coleccion}.${nombreIndice} existe pero con una definición DISTINTA a la esperada — se actualizaría con --confirm.`);
        resultados.push({ coleccion, nombreIndice, accion: 'pendiente_de_actualizar' });
        continue;
      }
      await collection.updateSearchIndex(nombreIndice, definition);
      console.log(`✅ ${coleccion}.${nombreIndice} actualizado — status PENDING mientras Atlas reconstruye (ver listSearchIndexes()).`);
      resultados.push({ coleccion, nombreIndice, accion: 'actualizado' });
      continue;
    }

    if (!confirm) {
      console.log(`🔎 ${coleccion}.${nombreIndice} NO existe — se crearía con --confirm.`);
      resultados.push({ coleccion, nombreIndice, accion: 'pendiente_de_crear' });
      continue;
    }

    await collection.createSearchIndex({ name: nombreIndice, type: 'vectorSearch', definition });
    console.log(`✅ ${coleccion}.${nombreIndice} creado — status PENDING (Atlas tarda un rato en construirlo, ver listSearchIndexes()).`);
    resultados.push({ coleccion, nombreIndice, accion: 'creado' });
  }

  if (!confirm) {
    console.log('\n🔎 Dry-run (default) — no se aplicó ningún cambio. Corré con --confirm para aplicar.');
  }

  return resultados;
}

module.exports = { run, DEFINICIONES };

if (require.main === module) {
  const dns = require('dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  require('dotenv').config();
  const mongoose = require('mongoose');

  (async () => {
    const uri = process.env.MONGODB_URI_PROD;
    if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');

    const confirm = process.argv.includes('--confirm');

    await mongoose.connect(uri);
    console.log(`✅ Conectado a producción (${confirm ? 'CREANDO ÍNDICES' : 'solo lectura / dry-run'})`);

    await run(mongoose.connection.db, { confirm });

    await mongoose.disconnect();
  })().catch((err) => {
    console.error('❌ ERROR:', err.message);
    process.exit(1);
  });
}
