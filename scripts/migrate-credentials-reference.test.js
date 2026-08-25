// Test real (Jest, commiteado) de scripts/migrate-credentials-reference.js
// — Fase 2.1 del blueprint Meta+Gupshup Embedded Signup (PR 2).
//
// Contra Mongo real, en una base de datos propia de este archivo. Los
// fixtures se insertan vía el driver NATIVO (collection.insertOne), no vía
// el modelo Mongoose WhatsAppChannel — el schema ya tipa
// credentialsReference como ObjectId, así que crear un documento con el
// string legacy a través del modelo fallaría el cast antes de llegar a
// Mongo. Insertar por el driver nativo es exactamente lo que reproduce el
// estado real que esta migración tiene que encontrar en producción.
const mongoose = require('mongoose');
const { findLegacyDocs, clearLegacyCredentialsReference, run, COLLECTION_NAME } = require('./migrate-credentials-reference');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_migrate_credentials_reference';

describe('migrate-credentials-reference', () => {
  let collection;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    collection = mongoose.connection.db.collection(COLLECTION_NAME);
  });

  afterAll(async () => {
    await collection.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await collection.deleteMany({});
  });

  test('findLegacyDocs: encuentra solo los documentos con credentialsReference tipo string', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertMany([
      { _id: legacyId, connectionType: 'PLATFORM', credentialsReference: 'env:GUPSHUP_API_KEY' },
      { _id: new mongoose.Types.ObjectId(), connectionType: 'DEDICATED', credentialsReference: null },
      { _id: new mongoose.Types.ObjectId(), connectionType: 'DEDICATED', credentialsReference: new mongoose.Types.ObjectId() },
      { _id: new mongoose.Types.ObjectId(), connectionType: 'PLATFORM' }, // campo ausente
    ]);

    const docs = await findLegacyDocs(collection);

    expect(docs).toHaveLength(1);
    expect(String(docs[0]._id)).toBe(String(legacyId));
    expect(docs[0].credentialsReference).toBe('env:GUPSHUP_API_KEY');
  });

  test('sin ningún documento legacy, run() no reporta candidatos y no escribe nada', async () => {
    await collection.insertOne({ connectionType: 'DEDICATED', credentialsReference: null });

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 0, migrados: 0 });
  });

  test('dry-run (default, sin confirm): loguea los candidatos pero NO los toca', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: legacyId, connectionType: 'PLATFORM', credentialsReference: 'env:GUPSHUP_API_KEY' });

    const result = await run(collection); // sin { confirm: true } → dry-run

    expect(result).toEqual({ candidatos: 1, migrados: 0 });

    const docSinTocar = await collection.findOne({ _id: legacyId });
    expect(docSinTocar.credentialsReference).toBe('env:GUPSHUP_API_KEY');
  });

  test('dry-run explícito (confirm:false): mismo comportamiento que el default', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: legacyId, connectionType: 'PLATFORM', credentialsReference: 'env:GUPSHUP_API_KEY' });

    const result = await run(collection, { confirm: false });

    expect(result).toEqual({ candidatos: 1, migrados: 0 });
    const docSinTocar = await collection.findOne({ _id: legacyId });
    expect(docSinTocar.credentialsReference).toBe('env:GUPSHUP_API_KEY');
  });

  test('con --confirm (confirm:true): deja credentialsReference en null', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: legacyId, connectionType: 'PLATFORM', credentialsReference: 'env:GUPSHUP_API_KEY' });

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 1, migrados: 1 });

    const docMigrado = await collection.findOne({ _id: legacyId });
    expect(docMigrado.credentialsReference).toBeNull();
  });

  test('con --confirm no toca documentos que no son legacy (ya null u ObjectId)', async () => {
    const yaNullId = new mongoose.Types.ObjectId();
    const yaObjectIdId = new mongoose.Types.ObjectId();
    const credencialReal = new mongoose.Types.ObjectId();

    await collection.insertMany([
      { _id: yaNullId, connectionType: 'PLATFORM', credentialsReference: null },
      { _id: yaObjectIdId, connectionType: 'DEDICATED', credentialsReference: credencialReal },
    ]);

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 0, migrados: 0 });

    const docYaNull = await collection.findOne({ _id: yaNullId });
    const docYaObjectId = await collection.findOne({ _id: yaObjectIdId });
    expect(docYaNull.credentialsReference).toBeNull();
    expect(String(docYaObjectId.credentialsReference)).toBe(String(credencialReal));
  });

  test('clearLegacyCredentialsReference con lista vacía no hace ninguna escritura', async () => {
    const result = await clearLegacyCredentialsReference(collection, []);
    expect(result).toEqual({ modifiedCount: 0 });
  });

  test('migra varios documentos legacy a la vez, deja intactos los demás', async () => {
    const legacy1 = new mongoose.Types.ObjectId();
    const legacy2 = new mongoose.Types.ObjectId();
    const noLegacy = new mongoose.Types.ObjectId();

    await collection.insertMany([
      { _id: legacy1, connectionType: 'PLATFORM', credentialsReference: 'env:GUPSHUP_API_KEY' },
      { _id: legacy2, connectionType: 'PLATFORM', credentialsReference: 'env:OTRA_KEY_VIEJA' },
      { _id: noLegacy, connectionType: 'DEDICATED', credentialsReference: new mongoose.Types.ObjectId() },
    ]);

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 2, migrados: 2 });

    expect((await collection.findOne({ _id: legacy1 })).credentialsReference).toBeNull();
    expect((await collection.findOne({ _id: legacy2 })).credentialsReference).toBeNull();
    expect((await collection.findOne({ _id: noLegacy })).credentialsReference).not.toBeNull();
  });
});
