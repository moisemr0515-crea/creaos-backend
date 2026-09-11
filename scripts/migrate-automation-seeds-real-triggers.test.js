// Test real (Jest, Mongo real) de scripts/migrate-automation-seeds-real-
// triggers.js — Caso 5 del backlog, PR D/6. Ejercita
// migrarAutomatizacionesSemilla() directo, sin pasar por el bloque CLI
// (guardado con require.main === module, así requerir este archivo desde
// el test no exige MONGODB_URI_PROD ni intenta conectar/desconectar por
// su cuenta).
const mongoose = require('mongoose');
const Business = require('../src/modules/businesses/business.model');
const Pipeline = require('../src/modules/pipeline/pipeline.model');
const Automation = require('../src/modules/automations/automation.model');
const { migrarAutomatizacionesSemilla, PLACEHOLDER_VIEJO } = require('./migrate-automation-seeds-real-triggers');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_migrate_automation_seeds';

describe('migrate-automation-seeds-real-triggers#migrarAutomatizacionesSemilla()', () => {
  let business;
  const userId = new mongoose.Types.ObjectId();

  const STAGES_CON_GANADA = [
    { key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false },
    { key: 'ganado', name: 'Ganado', order: 2, isWon: true, isLost: false },
  ];

  const STAGES_SIN_GANADA = [
    { key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false },
  ];

  const crearAutomatizacionVieja = (type, overrides = {}) =>
    Automation.create({
      business: business._id,
      createdBy: userId,
      type,
      name: PLACEHOLDER_VIEJO[type].name,
      description: PLACEHOLDER_VIEJO[type].description,
      trigger: { type: 'manual', conditions: [] },
      actions: [{ order: 1, type: 'add_note', config: { content: `${type} (placeholder)` }, delay: 0 }],
      isActive: false,
      ...overrides,
    });

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

  test('migra un "followup" viejo (sin editar) al shape nuevo, refrescando name/description', async () => {
    const vieja = await crearAutomatizacionVieja('followup');

    const resumen = await migrarAutomatizacionesSemilla();

    expect(resumen).toEqual({ total: 1, migradas: 1, saltadas: 0, editadasPreservadas: 0, restantes: 0 });

    const migrada = (await Automation.findById(vieja._id)).toObject();
    expect(migrada.trigger.type).toBe('lead_stale');
    expect(migrada.trigger.conditions).toEqual([{ field: 'daysThreshold', operator: 'greater_than', value: 3 }]);
    expect(migrada.actions).toHaveLength(1);
    expect(migrada.actions[0].type).toBe('send_template');
    expect(migrada.name).toBe('Seguimientos automáticos');
    expect(migrada.description).not.toContain('Placeholder'); // se refrescó al texto nuevo
  });

  test('migra un "auto_close" viejo, resolviendo la etapa "ganada" real del pipeline del negocio', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES_CON_GANADA, isDefault: true, isActive: true });
    const vieja = await crearAutomatizacionVieja('auto_close');

    const resumen = await migrarAutomatizacionesSemilla();

    expect(resumen.migradas).toBe(1);
    const migrada = (await Automation.findById(vieja._id)).toObject();
    expect(migrada.trigger.type).toBe('stage_stalled');
    expect(migrada.actions[0].type).toBe('change_stage');
    expect(migrada.actions[0].config.stage).toBe('ganado');
  });

  test('preserva name/description editados a mano — solo actualiza trigger/actions', async () => {
    const vieja = await crearAutomatizacionVieja('followup', {
      name: 'Mi seguimiento personalizado',
      description: 'Lo edité yo, no me lo toquen',
    });

    const resumen = await migrarAutomatizacionesSemilla();

    expect(resumen).toEqual({ total: 1, migradas: 1, saltadas: 0, editadasPreservadas: 1, restantes: 0 });

    const migrada = (await Automation.findById(vieja._id)).toObject();
    expect(migrada.name).toBe('Mi seguimiento personalizado'); // preservado
    expect(migrada.description).toBe('Lo edité yo, no me lo toquen'); // preservado
    expect(migrada.trigger.type).toBe('lead_stale'); // el mecanismo SÍ se actualizó
    expect(migrada.actions[0].type).toBe('send_template');
  });

  test('un "auto_close" sin ninguna etapa "ganada" se salta — no bloquea otras automatizaciones del mismo negocio', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline sin ganada', stages: STAGES_SIN_GANADA, isDefault: true, isActive: true });
    const autoCloseVieja = await crearAutomatizacionVieja('auto_close');
    const followupVieja = await crearAutomatizacionVieja('followup');

    const resumen = await migrarAutomatizacionesSemilla();

    expect(resumen).toEqual({ total: 2, migradas: 1, saltadas: 1, editadasPreservadas: 0, restantes: 1 });

    const autoCloseSinMigrar = (await Automation.findById(autoCloseVieja._id)).toObject();
    expect(autoCloseSinMigrar.trigger.type).toBe('manual'); // se quedó como estaba

    const followupMigrada = (await Automation.findById(followupVieja._id)).toObject();
    expect(followupMigrada.trigger.type).toBe('lead_stale'); // no se vio afectada por el salto de la otra
  });

  test('una automatización que ya está en el shape nuevo no se toca (no la encuentra la query)', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES_CON_GANADA, isDefault: true, isActive: true });
    const yaMigrada = await Automation.create({
      business: business._id,
      createdBy: userId,
      type: 'followup',
      name: 'Seguimientos automáticos',
      description: 'Ya migrada antes',
      trigger: { type: 'lead_stale', conditions: [{ field: 'daysThreshold', operator: 'greater_than', value: 5 }] },
      actions: [{ order: 1, type: 'send_template', config: { templateId: 'tpl_x' }, delay: 0 }],
      isActive: true,
    });

    const resumen = await migrarAutomatizacionesSemilla();

    expect(resumen).toEqual({ total: 0, migradas: 0, saltadas: 0, editadasPreservadas: 0, restantes: 0 });

    const sinTocar = (await Automation.findById(yaMigrada._id)).toObject();
    expect(sinTocar.trigger.conditions[0].value).toBe(5); // el umbral custom que ya tenía sigue intacto
    expect(sinTocar.actions[0].config.templateId).toBe('tpl_x'); // la plantilla ya configurada sigue intacta
  });

  test('idempotente: correrlo una segunda vez no encuentra nada más para migrar', async () => {
    await Pipeline.create({ business: business._id, name: 'Pipeline', stages: STAGES_CON_GANADA, isDefault: true, isActive: true });
    await crearAutomatizacionVieja('followup');
    await crearAutomatizacionVieja('auto_close');

    await migrarAutomatizacionesSemilla(); // primera corrida
    const segunda = await migrarAutomatizacionesSemilla(); // segunda corrida

    expect(segunda).toEqual({ total: 0, migradas: 0, saltadas: 0, editadasPreservadas: 0, restantes: 0 });
  });
});
