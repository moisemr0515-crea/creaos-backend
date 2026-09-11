// Test real (Jest, commiteado) de lead.model.js — índices nuevos para el
// barrido de triggers de tiempo (Caso 7 del backlog, PR 1/3: solo modelo +
// índices). Confirma el patrón de query que va a usar
// timeTriggers.registry.js (PR 2/3): filtrar por negocio + rango de fecha
// sobre lastContactedAt/stageChangedAt.
//
// El caso del lead SIN lastContactedAt/stageChangedAt seteado (null) es a
// propósito: un filtro directo `{lastContactedAt: {$lt: cutoff}}` NO lo
// encuentra (null no es "menor que" ninguna fecha para Mongo) — por eso el
// diseño real del barrido (PR 3) usa un $or con fallback a `createdAt`,
// documentado en el plan de Caso 7. Este test deja registrado ese
// comportamiento base de Mongo, no todavía el $or completo (eso se prueba
// en timeTriggers.registry.test.js cuando exista, PR 2).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Lead = require('./lead.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_time_trigger';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('lead.model — índices para el barrido de triggers de tiempo', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('filtra por business + isDeleted + lastContactedAt (rango de fecha)', async () => {
    const now = Date.now();
    const staleLead = await Lead.create({
      business: business._id,
      name: 'Lead sin contacto hace 5 días',
      lastContactedAt: new Date(now - 5 * DAY_MS),
    });
    await Lead.create({
      business: business._id,
      name: 'Lead contactado ayer',
      lastContactedAt: new Date(now - 1 * DAY_MS),
    });

    const cutoff = new Date(now - 3 * DAY_MS);
    const stale = await Lead.find({ business: business._id, isDeleted: false, lastContactedAt: { $lt: cutoff } });

    expect(stale).toHaveLength(1);
    expect(stale[0]._id.toString()).toBe(staleLead._id.toString());
  });

  test('un lead sin lastContactedAt seteado NO matchea un filtro directo $lt (por eso el diseño real usa $or con fallback a createdAt)', async () => {
    await Lead.create({ business: business._id, name: 'Lead nunca contactado' });

    const cutoff = new Date(Date.now() + DAY_MS); // cualquier fecha futura debería "atraparlo" si null contara como pasado
    const encontrados = await Lead.find({ business: business._id, isDeleted: false, lastContactedAt: { $lt: cutoff } });

    expect(encontrados).toHaveLength(0);
  });

  test('el fallback a createdAt sí lo encuentra — mismo criterio que usará el $or del barrido real', async () => {
    const now = Date.now();
    const nuncaContactado = await Lead.create({
      business: business._id,
      name: 'Lead nunca contactado, creado hace 5 días',
    });
    // createdAt lo pone Mongoose automáticamente al crear, y con
    // `timestamps:true` lo trata como inmutable — Lead.updateOne() lo
    // ignora en silencio (confirmado empíricamente). Se actualiza directo
    // vía el driver nativo (Lead.collection, sin pasar por Mongoose) para
    // simular que el lead se creó hace 5 días.
    await Lead.collection.updateOne({ _id: nuncaContactado._id }, { $set: { createdAt: new Date(now - 5 * DAY_MS) } });

    const cutoff = new Date(now - 3 * DAY_MS);
    const stale = await Lead.find({
      business: business._id,
      isDeleted: false,
      $or: [
        { lastContactedAt: { $lt: cutoff } },
        { lastContactedAt: null, createdAt: { $lt: cutoff } },
      ],
    });

    expect(stale).toHaveLength(1);
    expect(stale[0]._id.toString()).toBe(nuncaContactado._id.toString());
  });

  test('filtra por business + isDeleted + stageChangedAt (mismo patrón, para "stage_stalled")', async () => {
    const now = Date.now();
    const estancado = await Lead.create({
      business: business._id,
      name: 'Lead estancado hace 10 días',
      stageChangedAt: new Date(now - 10 * DAY_MS),
    });
    await Lead.create({
      business: business._id,
      name: 'Lead con cambio de etapa reciente',
      stageChangedAt: new Date(now - 1 * DAY_MS),
    });

    const cutoff = new Date(now - 7 * DAY_MS);
    const estancados = await Lead.find({ business: business._id, isDeleted: false, stageChangedAt: { $lt: cutoff } });

    expect(estancados).toHaveLength(1);
    expect(estancados[0]._id.toString()).toBe(estancado._id.toString());
  });

  test('un lead de OTRO negocio, aunque esté stale, no aparece — el filtro por business sigue siendo obligatorio', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });
    await Lead.create({
      business: otroBusiness._id,
      name: 'Lead stale de otro negocio',
      lastContactedAt: new Date(Date.now() - 30 * DAY_MS),
    });

    const cutoff = new Date(Date.now() - 3 * DAY_MS);
    const stale = await Lead.find({ business: business._id, isDeleted: false, lastContactedAt: { $lt: cutoff } });

    expect(stale).toHaveLength(0);
  });
});
