// Test real (Jest, commiteado) de automation.model.js — capacidad nueva del
// motor para triggers de tiempo (Caso 7 del backlog, PR 1/3: solo modelo +
// índices). Confirma que 'lead_stale'/'stage_stalled' son valores válidos
// de trigger.type, y que el índice global {'trigger.type', isActive,
// isDeleted} (sin `business` como prefijo) permite la pregunta que necesita
// el barrido: "en TODOS los negocios, qué automatizaciones activas tienen
// un trigger de tiempo" — a diferencia del índice existente
// {business, 'trigger.type', ...}, pensado para el caso de uso de siempre
// (un business ya conocido, ver triggerAutomations()).
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Automation = require('./automation.model');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_automation_time_trigger';

describe('automation.model — triggers de tiempo (lead_stale / stage_stalled)', () => {
  let businessA;
  let businessB;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Automation.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Automation.deleteMany({});
    await Business.deleteMany({});
    businessA = await Business.create({ name: 'Negocio A' });
    businessB = await Business.create({ name: 'Negocio B' });
  });

  const crearAutomatizacion = (business, overrides = {}) =>
    Automation.create({
      business: business._id,
      name: 'Seguimientos automáticos',
      trigger: { type: 'lead_stale', conditions: [] },
      actions: [{ order: 1, type: 'add_note', config: { content: 'placeholder' } }],
      isActive: true,
      ...overrides,
    });

  test('acepta trigger.type: "lead_stale" y "stage_stalled"', async () => {
    const stale = await crearAutomatizacion(businessA);
    expect(stale.trigger.type).toBe('lead_stale');

    const stalled = await crearAutomatizacion(businessA, {
      name: 'Cierre automático',
      trigger: { type: 'stage_stalled', conditions: [] },
    });
    expect(stalled.trigger.type).toBe('stage_stalled');
  });

  test('sigue rechazando un trigger.type que no existe en el enum', async () => {
    await expect(
      Automation.create({
        business: businessA._id,
        name: 'Inválida',
        trigger: { type: 'algo_inventado', conditions: [] },
        actions: [{ order: 1, type: 'add_note', config: { content: 'x' } }],
      })
    ).rejects.toThrow();
  });

  test('el índice global encuentra automatizaciones de tiempo activas cruzando negocios, sin filtrar por business', async () => {
    await crearAutomatizacion(businessA);
    await crearAutomatizacion(businessB);
    // Ruido: mismo trigger.type pero inactiva, y otra activa pero de un tipo distinto.
    await crearAutomatizacion(businessA, { name: 'Inactiva', isActive: false });
    await crearAutomatizacion(businessA, {
      name: 'Otro tipo',
      trigger: { type: 'lead_created', conditions: [] },
    });

    const activas = await Automation.find({
      'trigger.type': 'lead_stale',
      isActive: true,
      isDeleted: false,
    });

    expect(activas).toHaveLength(2);
    const businessIds = activas.map((a) => a.business.toString()).sort();
    expect(businessIds).toEqual([businessA._id.toString(), businessB._id.toString()].sort());
  });

  test('una automatización borrada (isDeleted:true) no aparece en la query global', async () => {
    await crearAutomatizacion(businessA, { isDeleted: true });

    const activas = await Automation.find({
      'trigger.type': 'lead_stale',
      isActive: true,
      isDeleted: false,
    });

    expect(activas).toHaveLength(0);
  });
});
