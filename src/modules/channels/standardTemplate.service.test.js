const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const WhatsAppChannel = require('./whatsappChannel.model');
const GupshupProvider = require('./providers/gupshupProvider');
const { STANDARD_TEMPLATE_PACK } = require('./standardTemplate.pack');
const { ensureStandardTemplatesForChannel } = require('./standardTemplate.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_standard_template_provisioning';

const rawTemplate = (definition, status = 'PENDING') => ({
  id: `provider-${definition.name}`,
  elementName: definition.name,
  status,
  languageCode: definition.language,
  category: definition.category,
});

describe('standardTemplate.service', () => {
  let business;
  let channel;

  beforeAll(() => mongoose.connect(MONGO_URI));
  afterAll(async () => {
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await WhatsAppChannel.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Tenant A' });
    channel = await WhatsAppChannel.create({
      tenantId: business._id,
      businessId: business._id,
      provider: 'gupshup',
      providerAppId: 'app-a',
      providerAccountId: 'tenant-a',
      phoneNumber: '+51900000001',
      phoneNumberId: 'phone-a',
      status: 'active',
      onboardingStatus: 'completed',
      connectionType: 'DEDICATED',
      outboundApi: 'partner',
    });
    jest.restoreAllMocks();
  });

  test('crea solo faltantes y persiste providerTemplateId/status reales', async () => {
    const existing = [rawTemplate(STANDARD_TEMPLATE_PACK[0], 'APPROVED'), rawTemplate(STANDARD_TEMPLATE_PACK[1], 'PENDING')];
    const finalCatalog = STANDARD_TEMPLATE_PACK.map((item, index) => rawTemplate(item, index === 0 ? 'APPROVED' : 'PENDING'));
    jest.spyOn(GupshupProvider.prototype, 'listTemplates')
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(finalCatalog);
    const createSpy = jest.spyOn(GupshupProvider.prototype, 'createTemplate')
      .mockImplementation(async (_channel, definition) => rawTemplate(definition));

    const result = await ensureStandardTemplatesForChannel(channel._id, business._id);

    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(createSpy.mock.calls.map((call) => call[1].name)).toEqual(STANDARD_TEMPLATE_PACK.slice(2).map((item) => item.name));
    expect(result.catalog).toHaveLength(5);
    const persisted = await WhatsAppChannel.findById(channel._id);
    expect(persisted.standardTemplates).toHaveLength(5);
    expect(persisted.standardTemplates[0]).toEqual(expect.objectContaining({
      providerTemplateId: 'provider-seguimiento_comercial',
      status: 'APPROVED',
    }));
  });

  test('persiste la respuesta real de creación aunque el listado sea eventualmente consistente', async () => {
    jest.spyOn(GupshupProvider.prototype, 'listTemplates')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    jest.spyOn(GupshupProvider.prototype, 'createTemplate')
      .mockImplementation(async (_channel, definition) => rawTemplate(definition));

    const result = await ensureStandardTemplatesForChannel(channel._id, business._id);

    expect(result.catalog).toHaveLength(STANDARD_TEMPLATE_PACK.length);
    expect(result.catalog[0]).toEqual(expect.objectContaining({
      providerTemplateId: 'provider-seguimiento_comercial',
      status: 'PENDING',
    }));
  });
  test('es idempotente: APPROVED, PENDING y REJECTED existentes no se recrean', async () => {
    const existing = STANDARD_TEMPLATE_PACK.map((item, index) => rawTemplate(item, ['APPROVED', 'PENDING', 'REJECTED'][index % 3]));
    jest.spyOn(GupshupProvider.prototype, 'listTemplates').mockResolvedValue(existing);
    const createSpy = jest.spyOn(GupshupProvider.prototype, 'createTemplate');

    await ensureStandardTemplatesForChannel(channel._id, business._id);
    await ensureStandardTemplatesForChannel(channel._id, business._id);

    expect(createSpy).not.toHaveBeenCalled();
  });

  test('tenant A no puede provisionar el canal de tenant B', async () => {
    const other = await Business.create({ name: 'Tenant B' });
    const listSpy = jest.spyOn(GupshupProvider.prototype, 'listTemplates');
    await expect(ensureStandardTemplatesForChannel(channel._id, other._id)).rejects.toMatchObject({ statusCode: 404 });
    expect(listSpy).not.toHaveBeenCalled();
  });
});