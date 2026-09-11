// Test real (Jest, Mongo real) de automationExecute.worker.js — Caso 7 del
// backlog, PR 3/3. No mockea runAutomation()/automation.engine.js: lo deja
// correr de verdad (acción add_note, sin llamadas externas) para confirmar
// la integración completa — automation.engine.js sigue sin ningún cambio,
// así que esto también sirve como prueba de que el recheck lo envuelve sin
// tocarlo.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Automation = require('../automation.model');
const AutomationLog = require('../automation-log.model');
const { processExecuteJob } = require('./automationExecute.worker');
const { DAYS_THRESHOLD_FIELD } = require('../timeTriggers.registry');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_automation_execute_worker';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('automationExecute.worker#processExecuteJob()', () => {
  let business;
  let automation;

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
      trigger: {
        type: 'lead_stale',
        conditions: [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 3 }],
      },
      actions: [{ order: 1, type: 'add_note', config: { content: 'Seguimiento automático disparado' } }],
      isActive: true,
    });
  });

  const job = (data) => ({ data });

  test('ejecuta la automatización de verdad cuando la condición sigue siendo cierta', async () => {
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead stale',
      lastContactedAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const resultado = await processExecuteJob(
      job({ automationId: automation._id, leadId: lead._id, triggerType: 'lead_stale' })
    );

    expect(resultado).toEqual({ executed: true });

    const leadActualizado = await Lead.findById(lead._id);
    expect(leadActualizado.notes).toHaveLength(1);
    expect(leadActualizado.notes[0].content).toBe('Seguimiento automático disparado');

    const log = await AutomationLog.findOne({ automation: automation._id, lead: lead._id });
    expect(log).not.toBeNull();
    expect(log.status).toBe('completed');
  });

  test('se salta (no ejecuta) si el lead ya no cumple la condición — recheck', async () => {
    // Escenario central del recheck: el lead SÍ estaba stale cuando el
    // barrido lo encontró, pero alguien lo contactó mientras este job
    // esperaba en la cola.
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead recién contactado',
      lastContactedAt: new Date(Date.now() - 1 * DAY_MS), // 1 día, no supera el umbral de 3
    });

    const resultado = await processExecuteJob(
      job({ automationId: automation._id, leadId: lead._id, triggerType: 'lead_stale' })
    );

    expect(resultado).toEqual({ skipped: true, reason: 'condition_no_longer_true' });

    const leadSinCambios = await Lead.findById(lead._id);
    expect(leadSinCambios.notes).toHaveLength(0);
    const log = await AutomationLog.findOne({ automation: automation._id, lead: lead._id });
    expect(log).toBeNull();
  });

  test('se salta si la automatización ya no está activa (se desactivó entre el barrido y la ejecución)', async () => {
    await Automation.findByIdAndUpdate(automation._id, { isActive: false });
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead stale',
      lastContactedAt: new Date(Date.now() - 5 * DAY_MS),
    });

    const resultado = await processExecuteJob(
      job({ automationId: automation._id, leadId: lead._id, triggerType: 'lead_stale' })
    );

    expect(resultado).toEqual({ skipped: true, reason: 'automation_not_active' });
    const leadSinCambios = await Lead.findById(lead._id);
    expect(leadSinCambios.notes).toHaveLength(0);
  });

  test('se salta si el lead ya no existe (borrado entre el barrido y la ejecución)', async () => {
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead que se borra',
      lastContactedAt: new Date(Date.now() - 5 * DAY_MS),
    });
    await Lead.findByIdAndUpdate(lead._id, { isDeleted: true });

    const resultado = await processExecuteJob(
      job({ automationId: automation._id, leadId: lead._id, triggerType: 'lead_stale' })
    );

    expect(resultado).toEqual({ skipped: true, reason: 'lead_not_found' });
  });
});
