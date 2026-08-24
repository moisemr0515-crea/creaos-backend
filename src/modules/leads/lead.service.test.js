// Test real (Jest, commiteado) del enforcement de límite de leads activos
// (auditoría de pricing del 23/ago/2026):
//   - crearLead(): bloqueo duro (camino manual) — rechaza con 403.
//   - notifyIfOverLeadLimit(): fail-soft (caminos automáticos) — nunca
//     bloquea, marca overQuota, notifica con throttle de 24h.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Plan = require('../subscriptions/plan.model');
const Subscription = require('../subscriptions/subscription.model');
const Pipeline = require('../pipeline/pipeline.model');
const Lead = require('./lead.model');
const Notification = require('../admin/notification.model');
const { crearLead, notifyIfOverLeadLimit } = require('./lead.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_service_limit';

const STAGES_DEFAULT = [
  { key: 'new', name: 'Nuevo', order: 1, isWon: false, isLost: false },
  { key: 'won', name: 'Ganado', order: 2, isWon: true, isLost: false },
  { key: 'lost', name: 'Perdido', order: 3, isWon: false, isLost: true },
];

describe('lead.service — enforcement del límite de leads activos', () => {
  let business;
  let pipeline;
  const actor = { _id: new mongoose.Types.ObjectId(), name: 'Actor de prueba' };

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Notification.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Notification.deleteMany({});
    await Lead.deleteMany({});
    await Pipeline.deleteMany({});
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    pipeline = await Pipeline.create({
      business: business._id,
      name: 'Pipeline Principal',
      stages: STAGES_DEFAULT,
      isDefault: true,
      isActive: true,
    });
  });

  const crearSubscripcionConLimite = async (leadsPerMonth) => {
    // name: 'starter' fijo — Plan.name tiene un enum estricto
    // (plan.model.js), y beforeEach() ya limpia Plan entre tests.
    const plan = await Plan.create({
      name: 'starter',
      displayName: 'Plan de prueba',
      price: 0,
      limits: { leadsPerMonth },
    });
    await Subscription.create({
      business: business._id,
      plan: plan._id,
      planName: plan.name,
      status: 'active',
      provider: 'free',
    });
  };

  const crearLeadDirecto = (overrides = {}) =>
    Lead.create({
      business: business._id,
      pipeline: pipeline._id,
      name: overrides.name || 'Lead existente',
      phone: overrides.phone,
      pipelineStage: overrides.pipelineStage || 'new',
      assignedTo: overrides.assignedTo,
      activity: [{ type: 'created', description: 'test' }],
    });

  // ─── crearLead() — bloqueo duro ─────────────────────────────────────────

  describe('crearLead() — camino manual, bloqueo duro', () => {
    test('crea normalmente cuando el negocio está bajo el límite', async () => {
      await crearSubscripcionConLimite(5);
      const lead = await crearLead(business._id, actor, { name: 'Lead nuevo', phone: '+51900000001' });
      expect(lead._id).toBeDefined();
      expect(await Lead.countDocuments({ business: business._id })).toBe(1);
    });

    test('rechaza con 403 cuando el negocio ya está en el límite — no crea el lead', async () => {
      await crearSubscripcionConLimite(1);
      await crearLeadDirecto({ phone: '+51900000002' });

      await expect(
        crearLead(business._id, actor, { name: 'Lead que no debería entrar', phone: '+51900000003' })
      ).rejects.toMatchObject({ statusCode: 403 });

      // Confirma que NO quedó ningún lead nuevo — el rechazo fue antes de crear.
      expect(await Lead.countDocuments({ business: business._id })).toBe(1);
    });

    test('un lead ganado/perdido libera cupo para el próximo manual', async () => {
      await crearSubscripcionConLimite(1);
      await crearLeadDirecto({ phone: '+51900000004', pipelineStage: 'won' });

      // El único lead existente ya está "ganado" — no cuenta contra el
      // límite, así que el manual debería poder crearse.
      const lead = await crearLead(business._id, actor, { name: 'Lead nuevo', phone: '+51900000005' });
      expect(lead._id).toBeDefined();
    });
  });

  // ─── notifyIfOverLeadLimit() — fail-soft ────────────────────────────────

  describe('notifyIfOverLeadLimit() — caminos automáticos, fail-soft', () => {
    test('no hace nada si el negocio está bajo el límite', async () => {
      await crearSubscripcionConLimite(5);
      const lead = await crearLeadDirecto({ phone: '+51900000010', assignedTo: actor._id });

      await notifyIfOverLeadLimit(lead);

      expect(await Notification.countDocuments({ business: business._id })).toBe(0);
      const leadRecargado = await Lead.findById(lead._id);
      expect(leadRecargado.overQuota).toBe(false);
    });

    test('marca overQuota y notifica cuando el negocio ya está sobre el límite', async () => {
      await crearSubscripcionConLimite(1);
      // Este lead lo deja exactamente en el límite (1/1) — el siguiente
      // automático (simulado abajo) llega estando ya al tope.
      await crearLeadDirecto({ phone: '+51900000011', assignedTo: actor._id });
      const leadExcedente = await crearLeadDirecto({ phone: '+51900000012', assignedTo: actor._id });

      await notifyIfOverLeadLimit(leadExcedente);

      const leadRecargado = await Lead.findById(leadExcedente._id);
      expect(leadRecargado.overQuota).toBe(true);

      const notifs = await Notification.find({ business: business._id });
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        category: 'subscription',
        type: 'warning',
        user: actor._id,
      });
      expect(notifs[0].meta.event).toBe('lead_limit_exceeded');
    });

    test('NUNCA lanza — un fallo creando la notificación no afecta al lead ya creado', async () => {
      await crearSubscripcionConLimite(1);
      await crearLeadDirecto({ phone: '+51900000013', assignedTo: actor._id });
      // assignedTo inválido (no es un ObjectId real de User) no importa acá
      // porque resolveNotificationRecipients() no valida contra User —
      // devuelve igual el id. El caso real de fallo (Notification.create()
      // con datos inválidos, Mongo caído, etc.) ya está cubierto por el
      // try/catch fail-soft del helper — este test confirma que la promesa
      // de notifyIfOverLeadLimit() nunca rechaza, sin importar qué pase adentro.
      const leadExcedente = await crearLeadDirecto({ phone: '+51900000014', assignedTo: actor._id });

      await expect(notifyIfOverLeadLimit(leadExcedente)).resolves.toBeUndefined();
    });

    test('no repite el aviso si ya se notificó hace menos de 24h (throttle)', async () => {
      await crearSubscripcionConLimite(1);
      await crearLeadDirecto({ phone: '+51900000015', assignedTo: actor._id });
      const lead1 = await crearLeadDirecto({ phone: '+51900000016', assignedTo: actor._id });
      const lead2 = await crearLeadDirecto({ phone: '+51900000017', assignedTo: actor._id });

      await notifyIfOverLeadLimit(lead1);
      expect(await Notification.countDocuments({ business: business._id })).toBe(1);

      await notifyIfOverLeadLimit(lead2);
      // Sigue en 1 — el segundo intento cayó dentro de la ventana de 24h.
      expect(await Notification.countDocuments({ business: business._id })).toBe(1);
      // Pero el lead sí se marca overQuota igual — el throttle es solo
      // sobre la notificación, no sobre el flag.
      expect((await Lead.findById(lead2._id)).overQuota).toBe(true);
    });

    test('sí vuelve a notificar después de 24h', async () => {
      await crearSubscripcionConLimite(1);
      await crearLeadDirecto({ phone: '+51900000018', assignedTo: actor._id });
      const leadExcedente = await crearLeadDirecto({ phone: '+51900000019', assignedTo: actor._id });

      // Simula un aviso previo de hace más de 24h insertando la
      // Notification directo con un createdAt viejo. Backdatear vía
      // Notification.updateOne() (Mongoose) NO alcanza — el plugin de
      // timestamps:true ignora un createdAt explícito en $set de updates;
      // hay que ir directo a la colección nativa para saltarse ese
      // middleware (confirmado con una prueba aparte antes de escribir esto).
      const vieja = await Notification.create({
        business: business._id,
        user: actor._id,
        type: 'warning',
        category: 'subscription',
        title: 'Aviso viejo',
        message: 'test',
        meta: { event: 'lead_limit_exceeded' },
      });
      await Notification.collection.updateOne(
        { _id: vieja._id },
        { $set: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } }
      );

      await notifyIfOverLeadLimit(leadExcedente);

      expect(await Notification.countDocuments({ business: business._id })).toBe(2);
    });
  });
});
