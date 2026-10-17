// Todo lead NUEVO nace con la probabilidad de cierre de SU etapa, sin importar el camino de creación (un único gancho en
// lead.model.js). Cada camino se prueba con la función REAL que lo ejecuta, no con una copia de sus campos. Mongo real.
jest.mock('../channels/queues/outbound.queue', () => ({
  enqueueOutbound: jest.fn().mockResolvedValue(undefined),
  getOutboundQueue: jest.fn(),
}));

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Pipeline = require('../pipeline/pipeline.model');
const Conversation = require('../ai/conversation.model');
const WebhookConfig = require('../webhooks/webhookConfig.model');
const WhatsAppChannel = require('../channels/whatsappChannel.model');
const aiService = require('../ai/ai.service');
const channelService = require('../channels/channel.service');
const subscriptionService = require('../subscriptions/subscription.service');
const Lead = require('./lead.model');
const leadService = require('./lead.service');
const { executeAction } = require('../automations/automation.engine');
const { ensureLeadAndConversation } = require('../channels/workers/inbound.worker');
const { processGupshupMessage, processWhatsAppMessage } = require('../webhooks/webhook.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_lead_probabilidad_por_etapa';
const actor = { _id: new mongoose.Types.ObjectId(), name: 'Actor de prueba' };
// Probabilidades del pipeline por defecto (pipeline.model.js): new 5 · contacted 20 · negotiating 60 · won 100 · lost 0.

describe('probabilidad de cierre por etapa en leads NUEVOS', () => {
  let negocio;
  let pipeline;
  let canal;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), WebhookConfig.deleteMany({}), WhatsAppChannel.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(subscriptionService, 'checkLeadLimit').mockResolvedValue({ allowed: true, current: 0, limit: 100 });
    jest.spyOn(subscriptionService, 'getEntitlement').mockResolvedValue({ planName: 'closer', limits: { aiEnabled: true, whatsappEnabled: true, automationsEnabled: true } });
    // Para que processGupshupMessage() no intente una respuesta real de IA ni de WhatsApp.
    jest.spyOn(aiService, 'saveInboundMessage').mockResolvedValue(undefined);
    jest.spyOn(aiService, 'generateReply').mockResolvedValue({ reply: 'hola' });
    jest.spyOn(channelService, 'getChannelForConversation').mockResolvedValue(null);
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), WebhookConfig.deleteMany({}), WhatsAppChannel.deleteMany({}), Business.deleteMany({})]);
    negocio = await Business.create({ name: 'Negocio de prueba', country: 'PE' });
    pipeline = await Pipeline.createDefault(negocio._id, actor._id);
    canal = await WhatsAppChannel.create({
      tenantId: negocio._id, businessId: negocio._id, provider: 'gupshup', connectionType: 'DEDICATED',
      phoneNumber: '+51999999999', phoneNumberId: `canal-${new mongoose.Types.ObjectId()}`, status: 'active',
    });
  });

  const probabilidad = async (filtro) => (await Lead.findOne({ business: negocio._id, ...filtro })).closeProbability;

  describe('cada camino de creación', () => {
    test('manual — crearLead(): sigue igual (la etapa que pidió)', async () => {
      const lead = await leadService.crearLead(negocio._id, actor, { name: 'Manual', pipelineStage: 'contacted' });
      expect(lead.closeProbability).toBe(20);
    });

    test('WhatsApp (worker) — ensureLeadAndConversation(): nace en «new» → 5 %', async () => {
      const { lead } = await ensureLeadAndConversation({ businessId: negocio._id, phone: '+51900000001', text: 'Hola', name: 'Ana', channelId: canal._id });
      expect(lead.closeProbability).toBe(5);
      expect(await probabilidad({ phone: '+51900000001' })).toBe(5);
    });

    test('WhatsApp (Gupshup) — processGupshupMessage()', async () => {
      await processGupshupMessage({ phone: '+51900000002', text: 'Hola, quiero info' }, negocio._id.toString());
      expect(await probabilidad({ phone: '+51900000002' })).toBe(5);
    });

    test('WhatsApp (Meta Cloud API) — processWhatsAppMessage()', async () => {
      await WebhookConfig.create({ business: negocio._id, platform: 'meta', pageId: 'phone-number-id-1', isActive: true });
      await processWhatsAppMessage({ phoneNumberId: 'phone-number-id-1', from: '+51900000003', name: 'Beto', text: 'Hola' });
      expect(await probabilidad({ phone: '+51900000003' })).toBe(5);
    });

    // Meta y TikTok crean el lead con esta misma forma (webhook.service.js): sin `pipeline`, con la etapa de
    // `config.defaults.pipelineStage`. Las funciones reales (processMetaLead/processTikTokLead) se prueban en
    // webhooks/webhook.service.metaTiktok.test.js.
    test.each([['Meta'], ['TikTok']])('%s — lead creado con la forma de processMetaLead/processTikTokLead y la etapa configurada', async (origen) => {
      const lead = await Lead.create({
        business: negocio._id, name: `Lead ${origen}`, source: origen === 'Meta' ? 'facebook' : 'tiktok',
        pipelineStage: 'negotiating', temperature: 'warm', tags: [],
      });
      expect(lead.closeProbability).toBe(60);
    });

    test('Meta (formularios): el lead sin etapa configurada nace en «new» → 5 %', async () => {
      const lead = await Lead.create({ business: negocio._id, name: 'Dani', source: 'facebook', pipelineStage: 'new', temperature: 'warm' });
      expect(lead.closeProbability).toBe(5);
    });

    test('automatización — create_lead (lead hijo en otra etapa)', async () => {
      const padre = await Lead.create({ business: negocio._id, name: 'Padre', pipeline: pipeline._id });
      const { createdLeadId } = await executeAction({ type: 'create_lead', config: { name: 'Hijo', pipelineStage: 'negotiating' } }, padre);
      expect((await Lead.findById(createdLeadId)).closeProbability).toBe(60);
    });

    test('importación — insertMany() (que no ejecuta pre-save)', async () => {
      await Lead.insertMany([
        { business: negocio._id, name: 'Import 1', pipeline: pipeline._id, pipelineStage: 'new' },
        { business: negocio._id, name: 'Import 2', pipeline: pipeline._id, pipelineStage: 'contacted' },
      ], { ordered: false });
      expect(await probabilidad({ name: 'Import 1' })).toBe(5);
      expect(await probabilidad({ name: 'Import 2' })).toBe(20);
    });
  });

  describe('respeta el pipeline PROPIO de cada negocio', () => {
    let propio;
    beforeEach(async () => {
      propio = await Pipeline.create({
        business: negocio._id, name: 'Propio', isDefault: false,
        stages: [
          { key: 'consulta', name: 'Consulta', order: 1, color: '#111111', defaultProbability: 15 },
          { key: 'reservado', name: 'Reservado', order: 2, color: '#222222', defaultProbability: 90, isWon: true },
        ],
      });
    });

    test('un lead con SU pipeline usa las probabilidades de ese pipeline, no las del por defecto', async () => {
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipeline: propio._id, pipelineStage: 'reservado' });
      expect(lead.closeProbability).toBe(90);
    });

    test('un lead sin pipeline usa el pipeline POR DEFECTO del negocio, aunque tenga etapas propias', async () => {
      await Pipeline.updateOne({ _id: pipeline._id }, { $set: { isDefault: false } });
      await Pipeline.updateOne({ _id: propio._id }, { $set: { isDefault: true } });

      // Como crean el lead Meta/TikTok y la automatización: sin `pipeline`, con una etapa del pipeline por defecto propio.
      const lead = await Lead.create({ business: negocio._id, name: 'Propio', pipelineStage: 'consulta' });

      expect(lead.closeProbability).toBe(15);
    });

    test('con otro negocio: cada uno usa SU pipeline (dos negocios, dos probabilidades para la misma etapa)', async () => {
      const otro = await Business.create({ name: 'Otro negocio', country: 'MX' });
      await Pipeline.create({
        business: otro._id, name: 'Otro', isDefault: true,
        stages: [{ key: 'new', name: 'Nuevo', order: 1, color: '#333333', defaultProbability: 33 }],
      });

      const a = await Lead.create({ business: negocio._id, name: 'A', pipelineStage: 'new' });
      const b = await Lead.create({ business: otro._id, name: 'B', pipelineStage: 'new' });

      expect(a.closeProbability).toBe(5);
      expect(b.closeProbability).toBe(33);
    });

    test('un pipeline de OTRO negocio nunca se usa, aunque el lead lo apunte: cae al por defecto del suyo', async () => {
      const otro = await Business.create({ name: 'Otro negocio', country: 'MX' });
      const ajeno = await Pipeline.create({
        business: otro._id, name: 'Ajeno', isDefault: true,
        stages: [{ key: 'new', name: 'Nuevo', order: 1, color: '#333333', defaultProbability: 99 }],
      });
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipeline: ajeno._id, pipelineStage: 'new' });
      expect(lead.closeProbability).toBe(5);
    });

    test('un pipeline inactivo se ignora y vale el por defecto', async () => {
      await Pipeline.updateOne({ _id: propio._id }, { $set: { isActive: false } });
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipeline: propio._id, pipelineStage: 'new' });
      expect(lead.closeProbability).toBe(5);
    });

    test('una etapa que NO existe en el pipeline deja la probabilidad como estaba (0), sin inventar', async () => {
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipeline: propio._id, pipelineStage: 'new' }); // 'new' no está en «Propio»
      expect(lead.closeProbability).toBe(0);
    });
  });

  describe('una probabilidad explícita se respeta', () => {
    test.each([[0], [37], [100]])('closeProbability %i explícita en una etapa de 60 %%', async (valor) => {
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipeline: pipeline._id, pipelineStage: 'negotiating', closeProbability: valor });
      expect(lead.closeProbability).toBe(valor);
      expect((await Lead.findById(lead._id)).closeProbability).toBe(valor);
    });

    test('también con insertMany()', async () => {
      await Lead.insertMany([{ business: negocio._id, name: 'Explícito', pipelineStage: 'negotiating', closeProbability: 0 }]);
      expect(await probabilidad({ name: 'Explícito' })).toBe(0);
    });
  });

  describe('solo leads NUEVOS', () => {
    test('un lead existente no cambia al guardarse de nuevo, ni al cambiarle la etapa por esta vía', async () => {
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipeline: pipeline._id, pipelineStage: 'new' });
      expect(lead.closeProbability).toBe(5);

      lead.pipelineStage = 'negotiating';
      lead.name = 'L editado';
      await lead.save();

      expect((await Lead.findById(lead._id)).closeProbability).toBe(5); // el gancho no la recalcula
    });

    test('un lead ANTIGUO con 0 % guardado no se toca al volver a guardarlo (no hay backfill escondido)', async () => {
      const { insertedId } = await Lead.collection.insertOne({
        business: negocio._id, name: 'Antiguo', pipeline: pipeline._id, pipelineStage: 'negotiating', closeProbability: 0,
        isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date(),
      });

      const antiguo = await Lead.findById(insertedId);
      antiguo.name = 'Antiguo editado';
      await antiguo.save();

      expect((await Lead.findById(insertedId)).closeProbability).toBe(0);
    });

    test('un lead existente sin campo closeProbability no se recalcula por su etapa al guardarse (queda en su 0 de siempre)', async () => {
      const { insertedId } = await Lead.collection.insertOne({ business: negocio._id, name: 'Sin campo', pipelineStage: 'contacted', isDeleted: false, isArchived: false });
      const l = await Lead.findById(insertedId);
      l.name = 'Sin campo editado';
      await l.save();
      expect((await Lead.collection.findOne({ _id: insertedId })).closeProbability).toBe(0); // el default de siempre, NO el 20 % de «contacted"
    });
  });

  describe('casos de borde', () => {
    test('un negocio SIN pipeline usa las etapas por defecto y el gancho NO crea ninguno (es una lectura)', async () => {
      await Pipeline.deleteMany({});
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipelineStage: 'contacted' });
      expect(lead.closeProbability).toBe(20);
      expect(await Pipeline.countDocuments({})).toBe(0);
    });

    test('el gancho solo toca closeProbability: no asigna pipeline ni cambia la etapa', async () => {
      const lead = await Lead.create({ business: negocio._id, name: 'L', pipelineStage: 'new' });
      expect(lead.pipeline).toBeUndefined();
      expect(lead.pipelineStage).toBe('new');
    });

    test('FAIL-SOFT: si no se puede leer el pipeline, el lead se crea igual (con 0 %)', async () => {
      jest.spyOn(Pipeline, 'findOne').mockImplementation(() => { throw new Error('mongo caído'); });
      const lead = await Lead.create({ business: negocio._id, name: 'No se pierde', pipelineStage: 'negotiating' });
      expect(lead._id).toBeDefined();
      expect(lead.closeProbability).toBe(0);
    });
  });
});
