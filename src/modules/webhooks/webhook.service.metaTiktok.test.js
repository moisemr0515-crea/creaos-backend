// Leads de Meta Ads (formularios) y TikTok: processMetaLead() y processTikTokLead() lanzaban "ReferenceError: business is not defined"
// (usaban `business._id` en assertActiveUserInBusiness, una variable que no existe en esas funciones) y NUNCA llegaban a crear el lead,
// desde el commit 2cd5075. El controlador responde 200 antes de procesar y solo registra err.message, así que fallaba en silencio.
// No existía ningún test de estas dos funciones. Mongo real; solo se simula la llamada HTTP a Meta y el token guardado.
jest.mock('./webhookConfigSecrets.service', () => ({
  ...jest.requireActual('./webhookConfigSecrets.service'),
  readSecret: jest.fn(() => 'token-de-prueba'),
}));

const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Conversation = require('../ai/conversation.model');
const Lead = require('../leads/lead.model');
const Pipeline = require('../pipeline/pipeline.model');
const Role = require('../roles/role.model');
const User = require('../users/user.model');
const WebhookConfig = require('./webhookConfig.model');
const { processMetaLead, processTikTokLead } = require('./webhook.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_webhook_meta_tiktok';

const camposMeta = (extra = []) => [
  { name: 'full_name', values: ['Dani Prado'] },
  { name: 'email', values: ['dani@example.com'] },
  { name: 'phone_number', values: ['+51987654321'] },
  { name: 'company_name', values: ['Empresa SAC'] },
  ...extra,
];
const respuestaMeta = (field_data = camposMeta()) => ({
  ok: true,
  json: async () => ({ field_data, ad_id: 'ad-1', adset_id: 'adset-1', campaign_id: 'camp-1' }),
});
const entradaMeta = (...leadgenIds) => ({
  id: 'page-1',
  changes: leadgenIds.map((leadgen_id) => ({ field: 'leadgen', value: { leadgen_id, form_id: 'form-1', page_id: 'page-1' } })),
});
const camposTikTok = [
  { name: 'FULL_NAME', value: 'Carla Rios' },
  { name: 'EMAIL', value: 'carla@example.com' },
  { name: 'PHONE_NUMBER', value: '+51912345678' },
];

describe('webhook.service — leads de Meta Ads y TikTok', () => {
  let negocio;
  let otroNegocio;
  let configMeta;
  let configTikTok;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    await WebhookConfig.init();
  });

  afterAll(async () => {
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), User.deleteMany({}), WebhookConfig.deleteMany({}), Business.deleteMany({})]);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([Conversation.deleteMany({}), Lead.deleteMany({}), Pipeline.deleteMany({}), User.deleteMany({}), WebhookConfig.deleteMany({}), Business.deleteMany({})]);
    negocio = await Business.create({ name: 'Negocio con anuncios', country: 'PE' });
    otroNegocio = await Business.create({ name: 'Otro negocio', country: 'MX' });
    await Pipeline.createDefault(negocio._id, new mongoose.Types.ObjectId());
    // verifyToken tiene un índice único: cada configuración lleva el suyo.
    configMeta = await WebhookConfig.create({ business: negocio._id, platform: 'meta', pageId: 'page-1', verifyToken: 'vt-meta', isActive: true });
    configTikTok = await WebhookConfig.create({ business: negocio._id, platform: 'tiktok', adAccountId: 'adv-1', verifyToken: 'vt-tiktok', isActive: true });
    jest.spyOn(global, 'fetch').mockResolvedValue(respuestaMeta());
  });

  const usuario = async (negocioId, extra = {}) => {
    const rol = await Role.findOneAndUpdate(
      { slug: 'owner', business: null },
      { name: 'Owner', slug: 'owner', business: null, isSystem: true, permissions: [] },
      { upsert: true, new: true }
    );
    return User.create({ business: negocioId, name: 'Agente', email: `a-${new mongoose.Types.ObjectId()}@test.com`, password: 'hash-de-prueba-123', role: rol._id, isActive: true, ...extra });
  };

  describe('Meta Ads — processMetaLead()', () => {
    test('YA NO lanza ReferenceError: crea el lead con los datos del formulario, en el negocio de la configuración', async () => {
      const resultados = await processMetaLead(entradaMeta('leadgen-1'), configMeta);

      expect(resultados).toEqual([{ leadgenId: 'leadgen-1', status: 'created', leadId: expect.anything() }]);
      const lead = await Lead.findOne({ business: negocio._id });
      expect(lead).toMatchObject({ name: 'Dani Prado', email: 'dani@example.com', phone: '+51987654321', company: 'Empresa SAC', source: 'facebook' });
      expect(lead.pipelineStage).toBe('new');
      expect(lead.temperature).toBe('warm');
      expect(lead.adSource).toMatchObject({ platform: 'meta', campaignId: 'camp-1', adSetId: 'adset-1', adId: 'ad-1', formId: 'form-1' });
    });

    test('crea también su conversación (para que el panel de chat tenga un conversationId) y actualiza los contadores de la configuración', async () => {
      await processMetaLead(entradaMeta('leadgen-1'), configMeta);

      const lead = await Lead.findOne({ business: negocio._id });
      const conversacion = await Conversation.findOne({ lead: lead._id });
      expect(conversacion).toMatchObject({ channel: 'manual', status: 'active', aiEnabled: true });
      const config = await WebhookConfig.findById(configMeta._id);
      expect(config.totalLeadsReceived).toBe(1);
      expect(config.lastReceivedAt).toBeInstanceOf(Date);
    });

    test('respeta los valores por defecto de la configuración: etapa, temperatura, fuente, etiquetas y agente asignado', async () => {
      const agente = await usuario(negocio._id);
      const config = { ...configMeta.toObject(), defaults: { pipelineStage: 'negotiating', temperature: 'hot', source: 'instagram', tags: ['campaña-oct'], assignedTo: agente._id } };

      await processMetaLead(entradaMeta('leadgen-1'), config);

      const lead = await Lead.findOne({ business: negocio._id });
      expect(lead).toMatchObject({ pipelineStage: 'negotiating', temperature: 'hot', source: 'instagram' });
      expect([...lead.tags]).toEqual(['campaña-oct']);
      expect(String(lead.assignedTo)).toBe(String(agente._id));
    });

    test('AISLAMIENTO: el agente asignado se valida contra el negocio de la configuración (uno de otro negocio se rechaza y no se crea nada)', async () => {
      const ajeno = await usuario(otroNegocio._id);
      const config = { ...configMeta.toObject(), defaults: { assignedTo: ajeno._id } };

      await expect(processMetaLead(entradaMeta('leadgen-1'), config)).rejects.toMatchObject({ statusCode: 400 });

      expect(await Lead.countDocuments({})).toBe(0);
    });

    test('el lead nace en el negocio de la configuración, nunca en otro', async () => {
      await processMetaLead(entradaMeta('leadgen-1'), configMeta);
      expect(await Lead.countDocuments({ business: otroNegocio._id })).toBe(0);
      expect(await Lead.countDocuments({ business: negocio._id })).toBe(1);
    });

    test('varios leads en la misma notificación: se crean todos', async () => {
      global.fetch
        .mockResolvedValueOnce(respuestaMeta(camposMeta()))
        .mockResolvedValueOnce(respuestaMeta([{ name: 'full_name', values: ['Eva'] }, { name: 'email', values: ['eva@example.com'] }]));

      const resultados = await processMetaLead(entradaMeta('l1', 'l2'), configMeta);

      expect(resultados.map((r) => r.status)).toEqual(['created', 'created']);
      expect(await Lead.countDocuments({ business: negocio._id })).toBe(2);
      expect((await WebhookConfig.findById(configMeta._id)).totalLeadsReceived).toBe(2);
    });

    test('un correo que ya existe en el negocio: «duplicate», no se crea otro lead', async () => {
      await processMetaLead(entradaMeta('leadgen-1'), configMeta);
      const segunda = await processMetaLead(entradaMeta('leadgen-2'), configMeta);

      expect(segunda[0].status).toBe('duplicate');
      expect(await Lead.countDocuments({ business: negocio._id })).toBe(1);
    });

    test('sin nombre ni correo: se omite', async () => {
      global.fetch.mockResolvedValueOnce(respuestaMeta([{ name: 'phone_number', values: ['+51900000000'] }]));
      const resultados = await processMetaLead(entradaMeta('leadgen-1'), configMeta);
      expect(resultados[0]).toMatchObject({ status: 'skipped', reason: 'no_identifiable_data' });
      expect(await Lead.countDocuments({})).toBe(0);
    });

    test('formularios fuera de la lista de la configuración se omiten', async () => {
      const config = { ...configMeta.toObject(), formIds: ['otro-formulario'] };
      expect(await processMetaLead(entradaMeta('leadgen-1'), config)).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('si Meta no devuelve el lead (error de la API): «error» con su mensaje, sin crear nada ni lanzar', async () => {
      global.fetch.mockResolvedValueOnce({ ok: false, statusText: 'Bad Request', json: async () => ({ error: { message: 'token vencido' } }) });
      const resultados = await processMetaLead(entradaMeta('leadgen-1'), configMeta);
      expect(resultados[0]).toMatchObject({ status: 'error', error: expect.stringContaining('token vencido') });
      expect(await Lead.countDocuments({})).toBe(0);
    });
  });

  describe('TikTok — processTikTokLead()', () => {
    const payload = (extra = {}) => ({ lead_id: 'tt-1', ad_id: 'ad-9', campaign_id: 'camp-9', fields: camposTikTok, ...extra });

    test('YA NO lanza ReferenceError: crea el lead con los datos del formulario, en el negocio de la configuración', async () => {
      const resultados = await processTikTokLead(payload(), configTikTok);

      expect(resultados).toEqual([{ leadId: 'tt-1', status: 'created', newLeadId: expect.anything() }]);
      const lead = await Lead.findOne({ business: negocio._id });
      expect(lead).toMatchObject({ name: 'Carla Rios', email: 'carla@example.com', phone: '+51912345678', source: 'tiktok', pipelineStage: 'new', temperature: 'warm' });
      expect(lead.adSource).toMatchObject({ platform: 'tiktok', campaignId: 'camp-9', adId: 'ad-9' });
    });

    test('crea su conversación y actualiza los contadores de la configuración', async () => {
      await processTikTokLead(payload(), configTikTok);

      const lead = await Lead.findOne({ business: negocio._id });
      expect(await Conversation.countDocuments({ lead: lead._id, channel: 'manual', aiEnabled: true })).toBe(1);
      const config = await WebhookConfig.findById(configTikTok._id);
      expect(config.totalLeadsReceived).toBe(1);
      expect(config.lastReceivedAt).toBeInstanceOf(Date);
    });

    test('respeta los valores por defecto de la configuración y valida al agente contra el negocio', async () => {
      const agente = await usuario(negocio._id);
      const ajeno = await usuario(otroNegocio._id);

      await processTikTokLead(payload(), { ...configTikTok.toObject(), defaults: { pipelineStage: 'contacted', temperature: 'hot', assignedTo: agente._id } });
      const lead = await Lead.findOne({ business: negocio._id });
      expect(lead).toMatchObject({ pipelineStage: 'contacted', temperature: 'hot' });
      expect(String(lead.assignedTo)).toBe(String(agente._id));

      await expect(
        processTikTokLead(payload({ lead_id: 'tt-2', fields: [{ name: 'FULL_NAME', value: 'Otra' }] }), { ...configTikTok.toObject(), defaults: { assignedTo: ajeno._id } })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await Lead.countDocuments({ name: 'Otra' })).toBe(0);
    });

    test('una lista de leads: se crean todos; un correo repetido es «duplicate»; sin datos se omite', async () => {
      const resultados = await processTikTokLead([
        payload({ lead_id: 'a' }),
        payload({ lead_id: 'b', fields: [{ name: 'FULL_NAME', value: 'Beto' }, { name: 'EMAIL', value: 'beto@example.com' }] }),
        payload({ lead_id: 'c' }), // mismo correo que «a»
        payload({ lead_id: 'd', fields: [{ name: 'PHONE_NUMBER', value: '+51900000000' }] }),
      ], configTikTok);

      expect(resultados.map((r) => r.status)).toEqual(['created', 'created', 'duplicate', 'skipped']);
      expect(await Lead.countDocuments({ business: negocio._id })).toBe(2);
    });

    test('AISLAMIENTO: el lead nace en el negocio de la configuración', async () => {
      await processTikTokLead(payload(), configTikTok);
      expect(await Lead.countDocuments({ business: otroNegocio._id })).toBe(0);
    });
  });
});
