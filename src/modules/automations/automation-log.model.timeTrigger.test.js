// Test real (Jest, commiteado) de automation-log.model.js — índice nuevo
// para el cooldown del barrido de triggers de tiempo (Caso 7 del backlog,
// PR 1/3: solo modelo + índices). Confirma el patrón de query que va a usar
// automationSweep.worker.js (PR 3/3): "¿ya corrió esta automatización para
// este lead dentro de la ventana de cooldown?" — si sí, no se vuelve a
// encolar, aunque el lead siga cumpliendo la condición de tiempo.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Automation = require('./automation.model');
const Lead = require('../leads/lead.model');
const AutomationLog = require('./automation-log.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_automationlog_time_trigger';
const HOUR_MS = 60 * 60 * 1000;

describe('automation-log.model — cooldown del barrido de triggers de tiempo', () => {
  let business;
  let automation;
  let lead;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await AutomationLog.deleteMany({});
    await Automation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await AutomationLog.deleteMany({});
    await Automation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    automation = await Automation.create({
      business: business._id,
      name: 'Seguimientos automáticos',
      trigger: { type: 'lead_stale', conditions: [] },
      actions: [{ order: 1, type: 'add_note', config: { content: 'placeholder' } }],
    });
    lead = await Lead.create({ business: business._id, name: 'Lead de prueba' });
  });

  const crearLog = (startedAt) =>
    AutomationLog.create({
      business: business._id,
      automation: automation._id,
      lead: lead._id,
      trigger: { type: 'lead_stale' },
      status: 'completed',
      startedAt,
    });

  test('encuentra un log reciente dentro de la ventana de cooldown (24h)', async () => {
    await crearLog(new Date(Date.now() - 2 * HOUR_MS)); // hace 2h

    const cutoff = new Date(Date.now() - 24 * HOUR_MS);
    const reciente = await AutomationLog.findOne({
      automation: automation._id,
      lead: lead._id,
      startedAt: { $gte: cutoff },
    });

    expect(reciente).not.toBeNull();
  });

  test('no encuentra nada si el último log es más viejo que la ventana de cooldown', async () => {
    await crearLog(new Date(Date.now() - 48 * HOUR_MS)); // hace 2 días

    const cutoff = new Date(Date.now() - 24 * HOUR_MS);
    const reciente = await AutomationLog.findOne({
      automation: automation._id,
      lead: lead._id,
      startedAt: { $gte: cutoff },
    });

    expect(reciente).toBeNull();
  });

  test('un log de OTRO lead no cuenta para el cooldown de este lead', async () => {
    const otroLead = await Lead.create({ business: business._id, name: 'Otro lead' });
    await AutomationLog.create({
      business: business._id,
      automation: automation._id,
      lead: otroLead._id,
      trigger: { type: 'lead_stale' },
      status: 'completed',
      startedAt: new Date(),
    });

    const cutoff = new Date(Date.now() - 24 * HOUR_MS);
    const reciente = await AutomationLog.findOne({
      automation: automation._id,
      lead: lead._id,
      startedAt: { $gte: cutoff },
    });

    expect(reciente).toBeNull();
  });

  test('un log de OTRA automatización (mismo lead) no cuenta para este cooldown', async () => {
    const otraAutomation = await Automation.create({
      business: business._id,
      name: 'Cierre automático',
      trigger: { type: 'stage_stalled', conditions: [] },
      actions: [{ order: 1, type: 'add_note', config: { content: 'placeholder' } }],
    });
    await AutomationLog.create({
      business: business._id,
      automation: otraAutomation._id,
      lead: lead._id,
      trigger: { type: 'stage_stalled' },
      status: 'completed',
      startedAt: new Date(),
    });

    const cutoff = new Date(Date.now() - 24 * HOUR_MS);
    const reciente = await AutomationLog.findOne({
      automation: automation._id,
      lead: lead._id,
      startedAt: { $gte: cutoff },
    });

    expect(reciente).toBeNull();
  });
});
