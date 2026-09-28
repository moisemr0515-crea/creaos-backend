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
 *   node scripts/ensure-atlas-vector-indexes.js --confirm # crea/actualiza lo que falte
 *   node scripts/ensure-atlas-vector-indexes.js --check-ready # falla si algo no está READY
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

const VERSION_INDEX = {
  coleccion: 'businessdocuments',
  nombreIndice: 'business_1_version_unique',
  key: { business: 1, version: -1 },
};

/** Compara todos los atributos relevantes, sin depender del orden de fields. */
const mismaDefinicion = (definicionActual, definicionDeseada) => {
  const normalizar = (fields) => [...fields]
    .map((f) => JSON.stringify({
      type: f.type,
      path: f.path,
      numDimensions: f.numDimensions,
      similarity: f.similarity,
    }))
    .sort()
    .join('|');
  return normalizar(definicionActual?.fields || []) === normalizar(definicionDeseada.fields);
};

/**
 * @param {import('mongodb').Db} db
 * @param {{confirm?: boolean}} [opts]
 */
async function run(db, { confirm = false, requireReady = false } = {}) {
  const resultados = [];

  const versionCollection = db.collection(VERSION_INDEX.coleccion);
  const normalIndexes = await versionCollection.listIndexes().toArray().catch((error) => {
    if (/ns not found/i.test(error.message)) return [];
    throw error;
  });
  const sameVersionKey = (key = {}) => key.business === 1 && key.version === -1 && Object.keys(key).length === 2;
  const versionIndex = normalIndexes.find((index) => sameVersionKey(index.key));
  const duplicate = await versionCollection.aggregate([
    { $group: { _id: { business: '$business', version: '$version' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).toArray().then((rows) => rows[0] || null).catch((error) => {
    if (/ns not found/i.test(error.message)) return null;
    throw error;
  });

  if (duplicate) {
    resultados.push({ ...VERSION_INDEX, accion: 'conflicto_datos' });
    if (confirm || requireReady) throw new Error('Hay versiones duplicadas por negocio; no se puede crear el índice único');
  } else if (versionIndex?.unique === true) {
    resultados.push({ ...VERSION_INDEX, accion: 'ya_existia', status: 'READY' });
  } else if (confirm) {
    if (versionIndex) await versionCollection.dropIndex(versionIndex.name);
    await versionCollection.createIndex(VERSION_INDEX.key, { unique: true, name: VERSION_INDEX.nombreIndice });
    resultados.push({ ...VERSION_INDEX, accion: versionIndex ? 'actualizado' : 'creado', status: 'READY' });
  } else {
    resultados.push({ ...VERSION_INDEX, accion: versionIndex ? 'pendiente_de_actualizar' : 'pendiente_de_crear' });
  }

  for (const { coleccion, nombreIndice, definition } of DEFINICIONES) {
    const collection = db.collection(coleccion);
    const existentes = await collection.listSearchIndexes().toArray().catch((error) => {
      if (/ns not found/i.test(error.message)) return [];
      throw error;
    });
    const existente = existentes.find((idx) => idx.name === nombreIndice);

    if (existente && mismaDefinicion(existente.latestDefinition, definition)) {
      const status = existente.status || 'UNKNOWN';
      console.log(`✅ ${coleccion}.${nombreIndice} ya existe con la definición correcta — status ${status}.`);
      resultados.push({ coleccion, nombreIndice, accion: 'ya_existia', status });
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

  if (requireReady) {
    const noListos = resultados.filter((resultado) => resultado.accion !== 'ya_existia' || resultado.status !== 'READY');
    if (noListos.length) {
      throw new Error(`Infraestructura RAG no lista: ${noListos.map((r) => `${r.coleccion}.${r.nombreIndice}`).join(', ')}`);
    }
  }

  return resultados;
}

module.exports = { run, DEFINICIONES, VERSION_INDEX };

if (require.main === module) {
  const dns = require('dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  require('dotenv').config();
  const mongoose = require('mongoose');

  (async () => {
    const uri = process.env.MONGODB_URI_PROD;
    if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');

    const confirm = process.argv.includes('--confirm');
    const requireReady = process.argv.includes('--check-ready');

    await mongoose.connect(uri);
    console.log(`✅ Conectado a producción (${confirm ? 'CREANDO ÍNDICES' : 'solo lectura / dry-run'})`);

    await run(mongoose.connection.db, { confirm, requireReady });

    await mongoose.disconnect();
  })().catch((err) => {
    console.error('❌ ERROR:', err.message);
    process.exit(1);
  });
}
