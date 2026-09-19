// Test real (Jest, commiteado) de scripts/migrate-business-country-pe.js —
// Frente 2 (diagnóstico multipaís, 19/sep/2026).
const mongoose = require('mongoose');
const { findLegacyDocs, migrateToPe, run, COLLECTION_NAME } = require('./migrate-business-country-pe');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_migrate_business_country_pe';

describe('migrate-business-country-pe', () => {
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

  test('findLegacyDocs: encuentra solo los documentos con country:"MX"', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertMany([
      { _id: legacyId, name: 'Negocio viejo (default nunca tocado)', country: 'MX' },
      { _id: new mongoose.Types.ObjectId(), name: 'Negocio ya en Perú', country: 'PE' },
      { _id: new mongoose.Types.ObjectId(), name: 'Negocio real en Chile', country: 'CL' },
      { _id: new mongoose.Types.ObjectId(), name: 'Negocio sin country seteado' }, // campo ausente
    ]);

    const docs = await findLegacyDocs(collection);

    expect(docs).toHaveLength(1);
    expect(String(docs[0]._id)).toBe(String(legacyId));
    expect(docs[0].country).toBe('MX');
  });

  test('sin ningún documento con country:"MX", run() no reporta candidatos y no escribe nada', async () => {
    await collection.insertOne({ name: 'Negocio en Perú', country: 'PE' });

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 0, migrados: 0 });
  });

  test('dry-run (default, sin confirm): loguea los candidatos pero NO los toca', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: legacyId, name: 'Negocio viejo', country: 'MX' });

    const result = await run(collection); // sin { confirm: true } → dry-run

    expect(result).toEqual({ candidatos: 1, migrados: 0 });

    const docSinTocar = await collection.findOne({ _id: legacyId });
    expect(docSinTocar.country).toBe('MX');
  });

  test('con --confirm (confirm:true): deja country en "PE"', async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await collection.insertOne({ _id: legacyId, name: 'Negocio viejo', country: 'MX' });

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 1, migrados: 1 });

    const docMigrado = await collection.findOne({ _id: legacyId });
    expect(docMigrado.country).toBe('PE');
  });

  test('con --confirm NO toca negocios reales que ya eligieron otro país (Chile, Colombia, Bolivia)', async () => {
    const chileId = new mongoose.Types.ObjectId();
    const colombiaId = new mongoose.Types.ObjectId();
    const boliviaId = new mongoose.Types.ObjectId();
    const mxLegacyId = new mongoose.Types.ObjectId();

    await collection.insertMany([
      { _id: chileId, name: 'Negocio Chile', country: 'CL' },
      { _id: colombiaId, name: 'Negocio Colombia', country: 'CO' },
      { _id: boliviaId, name: 'Negocio Bolivia', country: 'BO' },
      { _id: mxLegacyId, name: 'Negocio viejo (default MX nunca tocado)', country: 'MX' },
    ]);

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 1, migrados: 1 });
    expect((await collection.findOne({ _id: chileId })).country).toBe('CL');
    expect((await collection.findOne({ _id: colombiaId })).country).toBe('CO');
    expect((await collection.findOne({ _id: boliviaId })).country).toBe('BO');
    expect((await collection.findOne({ _id: mxLegacyId })).country).toBe('PE');
  });

  test('migrateToPe con lista vacía no hace ninguna escritura', async () => {
    const result = await migrateToPe(collection, []);
    expect(result).toEqual({ modifiedCount: 0 });
  });

  test('migra varios documentos "MX" a la vez', async () => {
    const legacy1 = new mongoose.Types.ObjectId();
    const legacy2 = new mongoose.Types.ObjectId();

    await collection.insertMany([
      { _id: legacy1, name: 'Negocio 1', country: 'MX' },
      { _id: legacy2, name: 'Negocio 2', country: 'MX' },
    ]);

    const result = await run(collection, { confirm: true });

    expect(result).toEqual({ candidatos: 2, migrados: 2 });
    expect((await collection.findOne({ _id: legacy1 })).country).toBe('PE');
    expect((await collection.findOne({ _id: legacy2 })).country).toBe('PE');
  });
});
