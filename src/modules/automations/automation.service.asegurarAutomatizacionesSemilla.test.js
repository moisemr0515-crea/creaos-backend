// Test real (Jest, Mongo real) de automation.service.js#
// asegurarAutomatizacionesSemilla() — Caso 5 del backlog, PR C/6 (semilla
// cableada de verdad). Confirma que "Seguimientos automáticos" nace con
// trigger.type:'lead_stale' + acción send_template, y "Cierre automático"
// con trigger.type:'stage_stalled' + acción change_stage apuntando a la
// etapa "ganada" REAL del pipeline de cada negocio (no una key fija) — y
// el caso acordado explícitamente: un negocio sin ninguna etapa "ganada"
// configurada salta esa semilla puntual sin romper el resto del seed.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Automation = require('./automation.model');
const { asegurarAutomatizacionesSemilla, AUTOMATIZACIONES_SEMILLA } = require('./automation.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_automation_seed_real_triggers';

describe('automation.service#asegurarAutomatizacionesSemilla() — Caso 5, PR C/6', () => {
  let business;
  const userId = new mongoose.Types.ObjectId();

  const STAGES_CON_GANADA = [
    { key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false },
    { key: 'ganado', name: 'Ganado', order: 2, isWon: true, isLost: false },
    { key: 'perdido', name: 'Perdido', order: 3, isWon: false, isLost: true },
  ];

  const STAGES_SIN_GANADA = [
    { key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false },
    { key: 'contacted', name: 'Contactado', order: 2, isWon: false, isLost: false },
  ];

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Automation.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Automation.deleteMany({});
    await Pipeline.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  test('con una etapa "ganada" real en el pipeline: siembra las 2 automatizaciones con trigger/acción reales', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES_CON_GANADA, isDefault: true, isActive: true });

    await asegurarAutomatizacionesSemilla(business._id, userId);

    const followupDoc = await Automation.findOne({ business: business._id, type: 'followup' });
    expect(followupDoc).not.toBeNull();
    // .toObject() convierte subdocumentos/DocumentArray de Mongoose a
    // objetos/arrays planos — compararlos directo con toEqual() contra un
    // literal revienta con un TypeError de Jest en subdocumentos Mongoose.
    const followup = followupDoc.toObject();
    expect(followup.trigger.type).toBe('lead_stale');
    expect(followup.trigger.conditions).toEqual([{ field: 'daysThreshold', operator: 'greater_than', value: 3 }]);
    expect(followup.actions).toHaveLength(1);
    expect(followup.actions[0].type).toBe('send_template');
    expect(followup.isActive).toBe(false);

    const autoCloseDoc = await Automation.findOne({ business: business._id, type: 'auto_close' });
    expect(autoCloseDoc).not.toBeNull();
    const autoClose = autoCloseDoc.toObject();
    expect(autoClose.trigger.type).toBe('stage_stalled');
    expect(autoClose.trigger.conditions).toEqual([{ field: 'daysThreshold', operator: 'greater_than', value: 7 }]);
    expect(autoClose.actions).toHaveLength(1);
    expect(autoClose.actions[0].type).toBe('change_stage');
    // La key real del pipeline de ESTE negocio, no una key fija tipo 'won'.
    expect(autoClose.actions[0].config.stage).toBe('ganado');
    expect(autoClose.isActive).toBe(false);
  });

  test('negocio sin ningún pipeline: obtenerOCrearDefault() crea uno (won incluido) y auto_close se siembra igual', async () => {
    // Sin ningún Pipeline.create() previo — mismo fallback que ya usa crearLead().
    await asegurarAutomatizacionesSemilla(business._id, userId);

    const autoClose = await Automation.findOne({ business: business._id, type: 'auto_close' });
    expect(autoClose).not.toBeNull();
    expect(autoClose.actions[0].config.stage).toBe('won'); // key del pipeline default (DEFAULT_STAGES)

    const pipelineCreado = await Pipeline.findOne({ business: business._id, isDefault: true });
    expect(pipelineCreado).not.toBeNull();
  });

  test('negocio con pipeline SIN etapa "ganada": salta auto_close, pero followup se siembra igual (no bloquea el resto)', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline sin ganada', stages: STAGES_SIN_GANADA, isDefault: true, isActive: true });

    await asegurarAutomatizacionesSemilla(business._id, userId);

    const autoClose = await Automation.findOne({ business: business._id, type: 'auto_close' });
    expect(autoClose).toBeNull(); // no se sembró, no hay etapa destino válida

    const followup = await Automation.findOne({ business: business._id, type: 'followup' });
    expect(followup).not.toBeNull(); // el resto del seed no se vio afectado
    expect(followup.trigger.type).toBe('lead_stale');
  });

  test('idempotente: llamarlo 2 veces no duplica ni pisa una automatización que el usuario ya editó', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES_CON_GANADA, isDefault: true, isActive: true });

    await asegurarAutomatizacionesSemilla(business._id, userId);
    const followup = await Automation.findOne({ business: business._id, type: 'followup' });
    await Automation.findByIdAndUpdate(followup._id, { name: 'Nombre editado por el usuario', isActive: true });

    await asegurarAutomatizacionesSemilla(business._id, userId); // segunda llamada

    const total = await Automation.countDocuments({ business: business._id });
    expect(total).toBe(2); // sigue siendo 1 followup + 1 auto_close, no se duplicó

    const followupReleido = await Automation.findOne({ business: business._id, type: 'followup' });
    expect(followupReleido.name).toBe('Nombre editado por el usuario'); // no se pisó
    expect(followupReleido.isActive).toBe(true); // tampoco se pisó
  });

  test('si un negocio sin etapa "ganada" corre el seed 2 veces, sigue sin sembrar auto_close (no queda a medias)', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline sin ganada', stages: STAGES_SIN_GANADA, isDefault: true, isActive: true });

    await asegurarAutomatizacionesSemilla(business._id, userId);
    await asegurarAutomatizacionesSemilla(business._id, userId);

    const autoClose = await Automation.findOne({ business: business._id, type: 'auto_close' });
    expect(autoClose).toBeNull();
  });

  test('AUTOMATIZACIONES_SEMILLA: auto_close queda con actions:null en el template estático (se resuelve por negocio, no es fijo)', () => {
    const autoCloseSemilla = AUTOMATIZACIONES_SEMILLA.find((s) => s.type === 'auto_close');
    expect(autoCloseSemilla.actions).toBeNull();
  });
});
