/**
 * Limpieza de los campos huérfanos `plan`/`planStatus` en la colección
 * `businesses`, tras la eliminación de ambos del schema en el Paso 3 de la
 * deprecación de business.plan (ver Business.model.js).
 *
 * POR QUÉ HACE FALTA (no es solo prolijidad):
 * Mongoose (con `strict: true`, el default) solo aplica el schema al
 * ESCRIBIR — al leer un documento que ya tiene en Mongo un campo que dejó
 * de estar declarado en el schema, ese campo sigue llegando a `_doc` y por
 * lo tanto sigue apareciendo en `.toObject()`/`.toJSON()` (confirmado
 * leyendo node_modules/mongoose/lib/document.js#init()/$__toObjectShallow
 * — la copia es `Object.keys(this._doc)`, no `Object.keys(schema.paths)`).
 * Sin este $unset, endpoints que devuelven el Business completo sin
 * `.select()` (ej. GET /admin/negocios/:id en admin.controller.js) seguirían
 * mostrando el `plan`/`planStatus` viejo y desincronizado de cada negocio
 * (6 de 7 negocios desincronizados según la auditoría original) — quedaría
 * una fuente de confusión aunque ningún código la lea como verdad.
 *
 * REVERSIBILIDAD:
 * Antes de tocar nada, este script escribe un backup JSON con el valor
 * actual de `plan`/`planStatus` de cada documento afectado en
 * backups/business-plan-fields-<timestamp>.json (carpeta ya gitignoreada,
 * ver scripts/backup-whatsapp-data.js para el mismo patrón). Para
 * revertir manualmente, se puede leer ese archivo y hacer
 * `Business.updateOne({ _id }, { $set: { plan, planStatus } })` por cada
 * entrada — no hay un flag de "undo" automático a propósito, para no
 * automatizar una operación que en la práctica no debería hacer falta
 * repetir.
 *
 * MODO DE USO (dry-run por default, no escribe nada sin --confirm):
 *   node scripts/unset-business-plan-fields.js
 *   node scripts/unset-business-plan-fields.js --confirm
 *
 * Antes de correr contra producción, correrlo primero contra un entorno de
 * desarrollo/staging y revisar el reporte de dry-run.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { MONGODB_URI } = require('../src/config/env');

const CONFIRM = process.argv.includes('--confirm');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log(`✅ Conectado a MongoDB${CONFIRM ? '' : ' (dry-run, no se escribe nada)'}\n`);

  // Colección cruda (sin el schema de Business, que ya no declara estos
  // campos) para poder leerlos tal cual están guardados en Mongo.
  const coleccion = mongoose.connection.collection('businesses');

  const afectados = await coleccion
    .find(
      { $or: [{ plan: { $exists: true } }, { planStatus: { $exists: true } }] },
      { projection: { name: 1, plan: 1, planStatus: 1 } },
    )
    .toArray();

  if (afectados.length === 0) {
    console.log('Ningún negocio tiene plan/planStatus guardado — nada que limpiar.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Negocios con plan/planStatus huérfano: ${afectados.length}`);
  for (const b of afectados) {
    console.log(`  - ${b._id} "${b.name}" — plan=${JSON.stringify(b.plan)} planStatus=${JSON.stringify(b.planStatus)}`);
  }

  if (!CONFIRM) {
    console.log('\nDry-run: no se modificó nada. Volvé a correr con --confirm para aplicar el $unset.');
    await mongoose.disconnect();
    return;
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `business-plan-fields-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(backupPath, JSON.stringify(afectados, null, 2));
  console.log(`\n📦 Backup escrito en ${backupPath} (${afectados.length} documentos)`);

  const resultado = await coleccion.updateMany(
    { $or: [{ plan: { $exists: true } }, { planStatus: { $exists: true } }] },
    { $unset: { plan: '', planStatus: '' } },
  );
  console.log(`\n✅ $unset aplicado: ${resultado.modifiedCount} documentos modificados.`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
