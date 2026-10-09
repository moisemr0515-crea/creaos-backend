const WhatsAppChannel = require('./whatsappChannel.model');
const GupshupProvider = require('./providers/gupshupProvider');
const { AppError } = require('../../middleware/error.middleware');
const { STANDARD_TEMPLATE_PACK } = require('./standardTemplate.pack');

const templateName = (raw) => String(raw?.elementName || raw?.name || raw?.templateName || '').trim().toLowerCase();
const templateId = (raw) => raw?.id || raw?._id || raw?.templateId || null;

function persistedTemplate(definition, raw) {
  const status = String(raw?.status || '').toUpperCase();
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    throw new AppError(`Gupshup no devolvió un estado válido para la plantilla ${definition.name}`, 502);
  }
  return {
    name: definition.name,
    displayName: definition.displayName,
    providerTemplateId: templateId(raw) ? String(templateId(raw)) : null,
    status,
    language: String(raw?.languageCode || raw?.language || definition.language),
    category: String(raw?.category || definition.category).toUpperCase(),
    syncedAt: new Date(),
  };
}

async function persistStandardTemplateCatalog(channel, providerTemplates) {
  const byName = new Map(providerTemplates.map((raw) => [templateName(raw), raw]));
  channel.standardTemplates = STANDARD_TEMPLATE_PACK
    .filter((definition) => byName.has(definition.name))
    .map((definition) => persistedTemplate(definition, byName.get(definition.name)));
  await channel.save();
  return channel.standardTemplates;
}

async function ensureStandardTemplatesForChannel(channelId, tenantId) {
  if (!tenantId) throw new AppError('tenantId es requerido para provisionar plantillas', 500);
  const channel = await WhatsAppChannel.findOne({
    _id: channelId,
    tenantId,
    businessId: tenantId,
    status: 'active',
  });
  if (!channel) throw new AppError('Canal de WhatsApp no encontrado o fuera del tenant', 404);
  if (channel.provider !== 'gupshup') throw new AppError('El provider del canal no soporta provisioning de plantillas', 409);

  const provider = new GupshupProvider();
  const before = await provider.listTemplates(channel);
  const existingNames = new Set(before.map(templateName));
  const created = [];
  const createdTemplates = [];

  for (const definition of STANDARD_TEMPLATE_PACK) {
    if (existingNames.has(definition.name)) continue;
    const raw = await provider.createTemplate(channel, definition);
    created.push({ name: definition.name, providerTemplateId: templateId(raw) ? String(templateId(raw)) : null });
    createdTemplates.push(raw);
    existingNames.add(definition.name);
  }

  const after = await provider.listTemplates(channel);
  const listedNames = new Set(after.map(templateName));
  const completeCatalog = [
    ...after,
    ...createdTemplates.filter((raw) => !listedNames.has(templateName(raw))),
  ];
  const catalog = await persistStandardTemplateCatalog(channel, completeCatalog);
  return {
    channelId: String(channel._id),
    businessId: String(channel.businessId),
    created,
    catalog: catalog.map((item) => item.toObject ? item.toObject() : item),
  };
}

module.exports = {
  ensureStandardTemplatesForChannel,
  persistStandardTemplateCatalog,
};