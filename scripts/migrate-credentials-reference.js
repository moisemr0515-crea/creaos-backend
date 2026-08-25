/**
 * Migración one-off — Fase 2.1 (docs/implementation/fase-2.1-blueprint-final.md
 * §1.2/§3). `WhatsAppChannel.credentialsReference` pasó de String libre a
 * ObjectId ref real hacia ChannelCredentials — el valor viejo (string, ej.
 * 'env:GUPSHUP_API_KEY', usado solo por el canal PLATFORM legacy) ya no es
 * un valor válido para ese campo. El discriminador PLATFORM/DEDICATED pasó
 * a ser `connectionType` (ver channelCredentials.service.js#resolveCredentials()),
 * así que ese string no hace falta para nada — se limpia a null.
 *
 * Corre vía el driver NATIVO de Mongo, no el modelo Mongoose: el schema ya
 * tipa credentialsReference como ObjectId, así que hidratar un documento
 * con el string viejo a través del modelo fallaría el cast. El driver
 * nativo lee/escribe el campo tal cual está en Mongo, sin pasar por el
 * schema.
 *
 * Dry-run por default — SIEMPRE loguea qué documentos va a tocar (_id,
 * connectionType, credentialsReference actual) antes de escribir nada.
 * Solo escribe con la flag --confirm.
 *
 * Uso:
 *   node scripts/migrate-credentials-reference.js           # dry-run, no escribe nada
 *   node scripts/migrate-credentials-reference.js --confirm # aplica el cambio
 *
 * Requiere MONGODB_URI_PROD en .env — corre contra producción a propósito.
 */
const COLLECTION_NAME = 'whatsappchannels'; // colección real detrás de mongoose.model('WhatsAppChannel', ...)

/**
 * Busca los WhatsAppChannel que todavía tienen credentialsReference como
 * string (formato viejo) — cualquier otro tipo (null, ObjectId, ausente) no
 * necesita migración.
 * @param {import('mongodb').Collection} collection
 * @returns {Promise<Array<{_id: any, connectionType: string, credentialsReference: string}>>}
 */
async function findLegacyDocs(collection) {
  return collection
    .find({ credentialsReference: { $type: 'string' } })
    .project({ connectionType: 1, credentialsReference: 1 })
    .toArray();
}

/**
 * Pone credentialsReference en null para los _id dados.
 * @param {import('mongodb').Collection} collection
 * @param {Array<any>} ids
 */
async function clearLegacyCredentialsReference(collection, ids) {
  if (ids.length === 0) return { modifiedCount: 0 };
  return collection.updateMany({ _id: { $in: ids } }, { $set: { credentialsReference: null } });
}

/**
 * Orquesta el dry-run/confirm. Siempre loguea los candidatos ANTES de
 * decidir si escribe o no.
 * @param {import('mongodb').Collection} collection
 * @param {{ confirm?: boolean }} [opts]
 * @returns {Promise<{ candidatos: number, migrados: number }>}
 */
async function run(collection, { confirm = false } = {}) {
  const docs = await findLegacyDocs(collection);

  if (docs.length === 0) {
    console.log('✅ Ningún WhatsAppChannel con credentialsReference legacy (string) — nada que migrar.');
    return { candidatos: 0, migrados: 0 };
  }

  console.log(`Encontrados ${docs.length} documento(s) con credentialsReference legacy (string):`);
  for (const doc of docs) {
    console.log(
      `   - ${doc._id} | connectionType: ${doc.connectionType} | credentialsReference actual: ${JSON.stringify(doc.credentialsReference)}`
    );
  }

  if (!confirm) {
    console.log('\n🔎 Dry-run (default) — no se escribió nada. Corré con --confirm para aplicar el cambio.');
    return { candidatos: docs.length, migrados: 0 };
  }

  const ids = docs.map((d) => d._id);
  const result = await clearLegacyCredentialsReference(collection, ids);
  console.log(`\n✅ ${result.modifiedCount} documento(s) actualizado(s) — credentialsReference → null.`);
  return { candidatos: docs.length, migrados: result.modifiedCount };
}

module.exports = { findLegacyDocs, clearLegacyCredentialsReference, run, COLLECTION_NAME };

if (require.main === module) {
  const dns = require('dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']); // el DNS local no resuelve el SRV de Atlas en algunos entornos — mismo override que otros scripts de este repo
  require('dotenv').config();
  const mongoose = require('mongoose');

  (async () => {
    const uri = process.env.MONGODB_URI_PROD;
    if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');

    const confirm = process.argv.includes('--confirm');

    await mongoose.connect(uri);
    console.log(`✅ Conectado a producción (${confirm ? 'ESCRIBIENDO' : 'solo lectura / dry-run'})`);

    const collection = mongoose.connection.db.collection(COLLECTION_NAME);
    await run(collection, { confirm });

    await mongoose.disconnect();
  })().catch((err) => {
    console.error('❌ ERROR — migración abortada:', err.message);
    process.exit(1);
  });
}
