// Test real (Jest, Mongo real, Redis/BullMQ mockeado) de
// automationSweep.worker.js — Caso 7 del backlog, PR 3/3.
//
// enqueueAutomationExecution() se mockea con jest.mock() (no jest.spyOn),
// mismo criterio ya establecido en inbound.worker.test.js: automationSweep.
// worker.js lo importa destructurado, así que una mutación posterior del
// módulo real no alcanzaría esa referencia ya capturada. Esto además evita
// que el test dependa de Redis estar corriendo — processSweepJob() nunca
// toca BullMQ de verdad, solo Mongo (Automation/Lead/AutomationLog) + la
// función de encolado mockeada.
jest.mock('../queues/automationExecute.queue', () => ({
  enqueueAutomationExecution: jest.fn().mockResolvedValue(undefined),
  getAutomationExecuteQueue: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Automation = require('../automation.model');
const AutomationLog = require('../automation-log.model');
const { enqueueAutomationExecution } = require('../queues/automationExecute.queue');
const { processSweepJob } = require('./automationSweep.worker');
const { DAYS_THRESHOLD_FIELD } = require('../timeTriggers.registry');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_automation_sweep_worker';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('automationSweep.worker#processSweepJob()', () => {
  let business;

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
    jest.clearAllMocks();
    await AutomationLog.deleteMany({});
    await Automation.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
  });

  const crearAutomatizacionLeadStale = (biz, dias = 3, overrides = {}) =>
    Automation.create({
      business: biz._id,
      name: 'Seguimientos automáticos',
      trigger: {
        type: 'lead_stale',
        conditions: [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: dias }],
      },
      actions: [{ order: 1, type: 'add_note', config: { content: 'placeholder' } }],
      isActive: true,
      ...overrides,
    });

  test('encola solo los leads que superan el umbral, no los contactados recientemente', async () => {
    const automation = await crearAutomatizacionLeadStale(business, 3);
    const stale = await Lead.create({
      business: business._id,
      name: 'Lead stale',
      lastContactedAt: new Date(Date.now() - 5 * DAY_MS),
    });
    await Lead.create({
      business: business._id,
      name: 'Lead reciente',
      lastContactedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    const resultado = await processSweepJob();

    expect(resultado).toEqual({ totalCandidatos: 1, totalEncolados: 1 });
    expect(enqueueAutomationExecution).toHaveBeenCalledTimes(1);
    expect(enqueueAutomationExecution).toHaveBeenCalledWith({
      automationId: automation._id,
      leadId: stale._id,
      triggerType: 'lead_stale',
    });
  });

  test('no re-encola un lead que ya tiene un log reciente (cooldown activo)', async () => {
    const automation = await crearAutomatizacionLeadStale(business, 3);
    const stale = await Lead.create({
      business: business._id,
      name: 'Lead stale ya procesado',
      lastContactedAt: new Date(Date.now() - 5 * DAY_MS),
    });
    await AutomationLog.create({
      business: business._id,
      automation: automation._id,
      lead: stale._id,
      trigger: { type: 'lead_stale' },
      status: 'completed',
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // hace 2h, dentro del cooldown de 24h
    });

    const resultado = await processSweepJob();

    expect(resultado.totalCandidatos).toBe(1); // sigue siendo candidato...
    expect(resultado.totalEncolados).toBe(0); // ...pero no se re-encola
    expect(enqueueAutomationExecution).not.toHaveBeenCalled();
  });

  test('sí re-encola si el log existente es más viejo que la ventana de cooldown', async () => {
    const automation = await crearAutomatizacionLeadStale(business, 3);
    const stale = await Lead.create({
      business: business._id,
      name: 'Lead stale, log viejo',
      lastContactedAt: new Date(Date.now() - 10 * DAY_MS),
    });
    await AutomationLog.create({
      business: business._id,
      automation: automation._id,
      lead: stale._id,
      trigger: { type: 'lead_stale' },
      status: 'completed',
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // hace 2 días, fuera del cooldown de 24h
    });

    const resultado = await processSweepJob();

    expect(resultado.totalEncolados).toBe(1);
    expect(enqueueAutomationExecution).toHaveBeenCalledTimes(1);
  });

  test('cruza negocios — el índice global encuentra automatizaciones activas de todos los negocios en un solo barrido', async () => {
    const businessB = await Business.create({ name: 'Otro negocio' });
    await crearAutomatizacionLeadStale(business, 3);
    await crearAutomatizacionLeadStale(businessB, 3);
    await Lead.create({ business: business._id, name: 'Stale A', lastContactedAt: new Date(Date.now() - 5 * DAY_MS) });
    await Lead.create({ business: businessB._id, name: 'Stale B', lastContactedAt: new Date(Date.now() - 5 * DAY_MS) });

    const resultado = await processSweepJob();

    expect(resultado.totalEncolados).toBe(2);
  });

  test('un lead de OTRO negocio nunca se cuenta para una automatización que no es la suya', async () => {
    const businessB = await Business.create({ name: 'Otro negocio' });
    await crearAutomatizacionLeadStale(business, 3); // solo automatización en `business`
    await Lead.create({ business: businessB._id, name: 'Stale de otro negocio', lastContactedAt: new Date(Date.now() - 30 * DAY_MS) });

    const resultado = await processSweepJob();

    expect(resultado.totalCandidatos).toBe(0);
    expect(enqueueAutomationExecution).not.toHaveBeenCalled();
  });

  test('una automatización inactiva no participa del barrido', async () => {
    await crearAutomatizacionLeadStale(business, 3, { isActive: false });
    await Lead.create({ business: business._id, name: 'Stale', lastContactedAt: new Date(Date.now() - 30 * DAY_MS) });

    const resultado = await processSweepJob();

    expect(resultado.totalCandidatos).toBe(0);
  });

  test('una automatización mal configurada (sin daysThreshold) se salta sin tumbar el resto del barrido', async () => {
    // Automatización rota: falta la condición daysThreshold.
    await Automation.create({
      business: business._id,
      name: 'Mal configurada',
      trigger: { type: 'lead_stale', conditions: [] },
      actions: [{ order: 1, type: 'add_note', config: { content: 'x' } }],
      isActive: true,
    });
    // Automatización sana en OTRO negocio — debe seguir procesándose igual.
    const businessB = await Business.create({ name: 'Negocio sano' });
    await crearAutomatizacionLeadStale(businessB, 3);
    await Lead.create({ business: businessB._id, name: 'Stale sano', lastContactedAt: new Date(Date.now() - 10 * DAY_MS) });

    const resultado = await processSweepJob();

    expect(resultado.totalEncolados).toBe(1); // la automatización sana sí encoló
    expect(enqueueAutomationExecution).toHaveBeenCalledTimes(1);
  });

  test('stage_stalled usa stageChangedAt en vez de lastContactedAt', async () => {
    const automation = await Automation.create({
      business: business._id,
      name: 'Cierre automático',
      trigger: {
        type: 'stage_stalled',
        conditions: [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 7 }],
      },
      actions: [{ order: 1, type: 'add_note', config: { content: 'x' } }],
      isActive: true,
    });
    const estancado = await Lead.create({
      business: business._id,
      name: 'Lead estancado',
      stageChangedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    const resultado = await processSweepJob();

    expect(resultado.totalEncolados).toBe(1);
    expect(enqueueAutomationExecution).toHaveBeenCalledWith({
      automationId: automation._id,
      leadId: estancado._id,
      triggerType: 'stage_stalled',
    });
  });
});
