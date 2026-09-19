/**
 * Migración one-off — Frente 2 (diagnóstico multipaís, 19/sep/2026).
 * Business.country tenía default:'MX' desde el commit que creó el modelo
 * (2b4a11e, 28/jun/2026), nunca corregido — y ningún formulario del
 * frontend escribió jamás este campo (confirmado antes de esta migración,
 * ver business.service.js#camposPermitidos: está en la whitelist pero
 * ningún componente lo manda). Así que TODO documento con country:"MX" hoy
 * es 100% artefacto de ese default nunca corregido, nunca una elección real
 * de un tenant — seguro migrarlo sin distinción. El default del schema ya
 * se corrigió a 'PE' aparte (business.model.js); esto solo actualiza los
 * documentos que ya existían ANTES de ese cambio.
 *
 * Corre vía el driver NATIVO de Mongo, no el modelo Mongoose — mismo
 * criterio que migrate-credentials-reference.js: no hace falta hidratar
 * documentos completos para un $set de un solo campo, y evita cualquier
 * side-effect de hooks/validators del modelo sobre documentos que no se
 * están editando de verdad.
 *
 * Dry-run por default — SIEMPRE loguea qué documentos va a tocar (_id,
 * name) antes de escribir nada. Solo escribe con la flag --confirm.
 *
 * Uso:
 *   node scripts/migrate-business-country-pe.js           # dry-run, no escribe nada
 *   node scripts/migrate-business-country-pe.js --confirm # aplica el cambio
 *
 * Requiere MONGODB_URI_PROD en .env — corre contra producción a propósito.
 */
const COLLECTION_NAME = 'businesses'; // colección real detrás de mongoose.model('Business', ...)

/**
 * Busca los Business que todavía tienen country:"MX" — el único valor que
 * puede venir del default viejo, nunca de una elección real del usuario.
 * @param {import('mongodb').Collection} collection
 * @returns {Promise<Array<{_id: any, name: string, country: string}>>}
 */
async function findLegacyDocs(collection) {
  return collection.find({ country: 'MX' }).project({ name: 1, country: 1 }).toArray();
}

/**
 * Pone country en "PE" para los _id dados.
 * @param {import('mongodb').Collection} collection
 * @param {Array<any>} ids
 */
async function migrateToPe(collection, ids) {
  if (ids.length === 0) return { modifiedCount: 0 };
  return collection.updateMany({ _id: { $in: ids } }, { $set: { country: 'PE' } });
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
    console.log('✅ Ningún Business con country:"MX" — nada que migrar.');
    return { candidatos: 0, migrados: 0 };
  }

  console.log(`Encontrados ${docs.length} documento(s) con country:"MX":`);
  for (const doc of docs) {
    console.log(`   - ${doc._id} | name: ${doc.name}`);
  }

  if (!confirm) {
    console.log('\n🔎 Dry-run (default) — no se escribió nada. Corré con --confirm para aplicar el cambio.');
    return { candidatos: docs.length, migrados: 0 };
  }

  const ids = docs.map((d) => d._id);
  const result = await migrateToPe(collection, ids);
  console.log(`\n✅ ${result.modifiedCount} documento(s) actualizado(s) — country "MX" → "PE".`);
  return { candidatos: docs.length, migrados: result.modifiedCount };
}

module.exports = { findLegacyDocs, migrateToPe, run, COLLECTION_NAME };

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
