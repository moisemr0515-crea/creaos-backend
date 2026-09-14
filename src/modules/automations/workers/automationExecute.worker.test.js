// Test real (Jest, Mongo real) de automationExecute.worker.js — Caso 7 del
// backlog (PR 3/3) + Caso 5 (PR B/6, guardrail de notificación para
// stage_stalled). No mockea runAutomation()/automation.engine.js: lo deja
// correr de verdad (acciones add_note/change_stage, sin llamadas externas)
// para confirmar la integración completa — automation.engine.js sigue sin
// ningún cambio de comportamiento observable, así que esto también sirve
// como prueba de que el recheck y el guardrail lo envuelven sin tocarlo.
//
// pushService se intercepta con jest.spyOn (no jest.mock) porque
// automationExecute.worker.js lo importa como objeto completo — mismo
// criterio ya documentado en inbound.worker.test.js. notificationService
// se deja correr de verdad (una escritura simple a Mongo, sin dependencia
// externa) y se verifica el documento Notification resultante.
const mongoose = require('mongoose');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Automation = require('../automation.model');
const AutomationLog = require('../automation-log.model');
const Pipeline = require('../../pipeline/pipeline.model');
const Notification = require('../../admin/notification.model');
const pushService = require('../../push/push.service');
const subscriptionService = require('../../subscriptions/subscription.service');
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
    jest.restoreAllMocks();
    jest.spyOn(subscriptionService, 'assertCapability').mockResolvedValue({ planName: 'closer' });
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

describe('automationExecute.worker#processExecuteJob() — guardrail de notificación (stage_stalled)', () => {
  let business;
  let pipeline;
  let automation;
  const assignedTo = new mongoose.Types.ObjectId();

  const STAGES = [
    { key: 'new', name: 'Nuevo', order: 1 },
    { key: 'negotiating', name: 'Negociando', order: 2 },
  ];

  const job = (data) => ({ data });

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Notification.deleteMany({});
    await AutomationLog.deleteMany({});
    await Automation.deleteMany({});
    await Pipeline.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(subscriptionService, 'assertCapability').mockResolvedValue({ planName: 'closer' });
    await Notification.deleteMany({});
    await AutomationLog.deleteMany({});
    await Automation.deleteMany({});
    await Pipeline.deleteMany({});
    await Lead.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    pipeline = await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES, isDefault: true, isActive: true });
    automation = await Automation.create({
      business: business._id,
      name: 'Cierre automático',
      trigger: {
        type: 'stage_stalled',
        conditions: [{ field: DAYS_THRESHOLD_FIELD, operator: 'greater_than', value: 7 }],
      },
      actions: [{ order: 1, type: 'change_stage', config: { stage: 'negotiating' } }],
      isActive: true,
    });
  });

  test('change_stage exitoso + lead con assignedTo → notifica y manda push', async () => {
    const pushSpy = jest.spyOn(pushService, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0, tokens: 1 });
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead estancado',
      pipeline: pipeline._id,
      pipelineStage: 'new',
      assignedTo,
      stageChangedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    const resultado = await processExecuteJob(
      job({ automationId: automation._id, leadId: lead._id, triggerType: 'stage_stalled' })
    );
    expect(resultado).toEqual({ executed: true });

    const leadActualizado = await Lead.findById(lead._id);
    expect(leadActualizado.pipelineStage).toBe('negotiating'); // la etapa sí cambió

    const notif = await Notification.findOne({ user: assignedTo, category: 'automation' });
    expect(notif).not.toBeNull();
    expect(notif.message).toContain('negotiating');
    expect(notif.meta.event).toBe('stage_stalled_auto_change');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(assignedTo, expect.objectContaining({ title: expect.stringContaining('Lead estancado') }));
  });

  test('lead SIN assignedTo → cambia de etapa igual, pero no notifica a nadie', async () => {
    const pushSpy = jest.spyOn(pushService, 'sendToUser').mockResolvedValue({ sent: 0, failed: 0, tokens: 0 });
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead sin asignar',
      pipeline: pipeline._id,
      pipelineStage: 'new',
      stageChangedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    await processExecuteJob(job({ automationId: automation._id, leadId: lead._id, triggerType: 'stage_stalled' }));

    const leadActualizado = await Lead.findById(lead._id);
    expect(leadActualizado.pipelineStage).toBe('negotiating');

    const notif = await Notification.findOne({});
    expect(notif).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  test('triggerType distinto de stage_stalled nunca notifica, aunque la automatización use change_stage', async () => {
    const pushSpy = jest.spyOn(pushService, 'sendToUser').mockResolvedValue({ sent: 0, failed: 0, tokens: 0 });
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead stale (no stage_stalled)',
      pipeline: pipeline._id,
      pipelineStage: 'new',
      assignedTo,
      stageChangedAt: new Date(Date.now() - 10 * DAY_MS),
      lastContactedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    // Mismo automation (type stage_stalled en el modelo), pero se llama con
    // triggerType:'lead_stale' — simula un job mal etiquetado o un futuro
    // trigger distinto que reusara change_stage; el guardrail es explícito
    // por triggerType, no por lo que la acción haya hecho.
    await processExecuteJob(job({ automationId: automation._id, leadId: lead._id, triggerType: 'lead_stale' }));

    const notif = await Notification.findOne({});
    expect(notif).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  test('un fallo de notificationService.createNotification() no tumba el job (fail-soft)', async () => {
    const Notif = require('../../admin/notification.service');
    const createSpy = jest.spyOn(Notif, 'createNotification').mockRejectedValue(new Error('Mongo caído'));
    const lead = await Lead.create({
      business: business._id,
      name: 'Lead estancado',
      pipeline: pipeline._id,
      pipelineStage: 'new',
      assignedTo,
      stageChangedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    const resultado = await processExecuteJob(
      job({ automationId: automation._id, leadId: lead._id, triggerType: 'stage_stalled' })
    );

    // El cambio de etapa ya se guardó y el job se considera ejecutado
    // igual — el fallo de notificación es un problema aparte, no debe
    // revertir ni reintentar la automatización entera.
    expect(resultado).toEqual({ executed: true });
    const leadActualizado = await Lead.findById(lead._id);
    expect(leadActualizado.pipelineStage).toBe('negotiating');

    createSpy.mockRestore();
  });
});
