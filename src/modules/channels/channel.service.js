const { AppError } = require('../../middleware/error.middleware');
const channelRepository = require('./channel.repository');
const GupshupProvider = require('./providers/gupshupProvider');
const logger = require('../../utils/logger');
const Conversation = require('../ai/conversation.model');
const standardTemplateService = require('./standardTemplate.service');

/**
 * ChannelService — fachada pública del módulo channels/ (Blueprint §4.4).
 * Es la única puerta de entrada: nadie fuera de channels/ debe importar
 * GupshupProvider ni gupshup.client.js directamente (principio "no acoplar
 * el Core a Gupshup", §5 del Blueprint).
 *
 * v1 (sub-fase 1.b): solo `provider: 'gupshup'` existe, así que el mapeo
 * provider→implementación es trivial hoy. Cuando exista un segundo
 * provider, este es el único lugar que cambia (un factory/switch simple).
 */

function getProviderFor(channel) {
  if (channel.provider === 'gupshup') return new GupshupProvider();
  throw new AppError(`Provider "${channel.provider}" sin implementación registrada`, 500);
}

/**
 * @param {string} channelId
 * @param {string} to
 * @param {string} text
 */
async function loadOperationalChannel(channelId, tenantId) {
  if (!tenantId) throw new AppError('tenantId es requerido para operar un canal', 500);
  const channel = await channelRepository.findByIdForTenant(channelId, tenantId);
  if (!channel) {
    throw new AppError(`WhatsAppChannel ${channelId} no encontrado`, 404);
  }
  if (channel.status !== 'active') {
    throw new AppError(`WhatsAppChannel ${channelId} no está activo`, 409);
  }
  return channel;
}

async function sendMessage(channelId, to, text, tenantId) {
  const channel = await loadOperationalChannel(channelId, tenantId);

  const provider = getProviderFor(channel);
  return provider.sendMessage(channel, to, text);
}

/**
 * Envía un mensaje de plantilla aprobada — a diferencia de sendMessage()
 * (texto libre), no requiere que la ventana de 24h esté abierta.
 * @param {string} channelId
 * @param {string} to
 * @param {{ id: string, params?: string[] }} template
 */
async function sendTemplate(channelId, to, template, tenantId) {
  const channel = await loadOperationalChannel(channelId, tenantId);

  const provider = getProviderFor(channel);
  return provider.sendTemplate(channel, to, template);
}

/**
 * Lista las plantillas aprobadas disponibles para un canal.
 * @param {string} channelId
 * @returns {Promise<Array>}
 */
const templateBody = (raw) => {
  if (typeof raw.body === 'string') return raw.body;
  if (typeof raw.text === 'string') return raw.text;
  const components = Array.isArray(raw.components) ? raw.components : [];
  const body = components.find((component) => String(component.type || '').toUpperCase() === 'BODY');
  if (typeof body?.text === 'string') return body.text;

  // Partner API entrega el cuerpo real dentro de containerMeta.data. El
  // campo top-level data agrega además los botones (" | [Botón]") y se
  // conserva solo como fallback para respuestas antiguas/incompletas.
  if (typeof raw.containerMeta === 'string') {
    try {
      const containerMeta = JSON.parse(raw.containerMeta);
      if (typeof containerMeta?.data === 'string') return containerMeta.data;
    } catch {
      // Catálogo externo malformado: continuar al fallback sin inventar body.
    }
  }
  return typeof raw.data === 'string' ? raw.data : null;
};

const readableTemplateName = (value) => String(value || '')
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

const TEMPLATE_VARIABLE_DEFINITIONS = {
  seguimiento_comercial: [
    { key: 'lead_name', label: 'Nombre del lead', source: 'lead.name' },
    { key: 'agent_name', label: 'Nombre del agente', source: 'business.agentName' },
    { key: 'business_name', label: 'Nombre del negocio', source: 'business.name' },
  ],
  seguimiento_cotizacion: [
    { key: 'lead_name', label: 'Nombre del lead', source: 'lead.name' },
    { key: 'business_name', label: 'Nombre del negocio', source: 'business.name' },
  ],
  reactivar_prospecto: [
    { key: 'lead_name', label: 'Nombre del lead', source: 'lead.name' },
    { key: 'agent_name', label: 'Nombre del agente', source: 'business.agentName' },
    { key: 'business_name', label: 'Nombre del negocio', source: 'business.name' },
  ],
  recordatorio_cita: [
    { key: 'lead_name', label: 'Nombre del lead', source: 'lead.name' },
    { key: 'agent_name', label: 'Nombre del agente', source: 'business.agentName' },
    { key: 'appointment_at', label: 'Fecha y hora', source: null },
  ],
  primer_contacto_comercial: [
    { key: 'lead_name', label: 'Nombre del lead', source: 'lead.name' },
    { key: 'agent_name', label: 'Nombre del agente', source: 'business.agentName' },
    { key: 'business_name', label: 'Nombre del negocio', source: 'business.name' },
  ],
};

const valueFromSource = (source, { lead, business } = {}) => {
  if (source === 'lead.name') return lead?.name;
  if (source === 'business.agentName') return business?.agentName;
  if (source === 'business.name') return business?.name;
  return null;
};

const templateVariableDefinitions = (templateName, variablesRequired) => {
  const configured = TEMPLATE_VARIABLE_DEFINITIONS[String(templateName || '').toLowerCase()] || [];
  return Array.from({ length: variablesRequired }, (_, offset) => {
    const definition = configured[offset] || {
      key: `variable_${offset + 1}`,
      label: `Variable {{${offset + 1}}}`,
      source: null,
    };
    return { index: offset + 1, ...definition, automatic: Boolean(definition.source) };
  });
};

const resolveTemplateVariables = (template, context = {}) => templateVariableDefinitions(
  template.name,
  template.variablesRequired
).map((definition) => ({
  ...definition,
  value: definition.automatic
    ? String(valueFromSource(definition.source, context) || '').trim()
    : null,
}));

const resolveTemplateParams = (template, context = {}, providedParams = []) => {
  const variables = resolveTemplateVariables(template, context);
  const params = variables.map((variable, offset) => (
    variable.automatic
      ? variable.value
      : String(providedParams[offset] || '').trim()
  ));
  const missing = variables.find((variable, offset) => !params[offset]);
  if (missing) {
    if (missing.key === 'appointment_at') {
      throw new AppError('Completa la fecha y hora antes de enviar.', 400);
    }
    throw new AppError(`Completa ${missing.label.toLowerCase()} antes de enviar.`, 400);
  }
  return params;
};

const normalizeTemplate = (raw, channel, tenantId) => {
  const providerTemplateId = raw.id || raw._id || raw.templateId;
  const name = raw.elementName || raw.name || raw.templateName;
  if (!providerTemplateId || !name) return null;
  const body = templateBody(raw);
  const placeholders = [...String(body || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => Number(match[1]));
  return {
    providerTemplateId: String(providerTemplateId),
    id: String(providerTemplateId),
    name: String(name),
    displayName: String(raw.displayName || readableTemplateName(name)),
    category: raw.category ? String(raw.category) : (raw.templateType ? String(raw.templateType) : null),
    language: raw.language ? String(raw.language) : (raw.languageCode ? String(raw.languageCode) : (raw.lang ? String(raw.lang) : null)),
    status: String(raw.status || '').toUpperCase(),
    body,
    variablesRequired: placeholders.length > 0 ? Math.max(...placeholders) : 0,
    channelId: String(channel._id),
    businessId: String(tenantId),
  };
};
async function listTemplates(channelId, tenantId) {
  const catalog = await getTemplateCatalog(channelId, tenantId);
  return catalog.templates;
}

async function getTemplateCatalog(channelId, tenantId) {
  const channel = await loadOperationalChannel(channelId, tenantId);
  const provider = getProviderFor(channel);
  const rawTemplates = await provider.listTemplates(channel);
  await standardTemplateService.persistStandardTemplateCatalog(channel, rawTemplates);
  const templates = rawTemplates
    .filter((raw) => String(raw.status || '').toUpperCase() === 'APPROVED')
    .filter((raw) => raw.active !== false && raw.isActive !== false)
    .map((raw) => normalizeTemplate(raw, channel, tenantId))
    .filter(Boolean);
  const pending = rawTemplates.some((raw) => String(raw.status || '').toUpperCase() === 'PENDING');
  return { templates, catalogStatus: templates.length > 0 ? 'approved' : (pending ? 'pending' : 'empty') };
}
async function getApprovedTemplate(channelId, tenantId, providerTemplateId) {
  const templates = await listTemplates(channelId, tenantId);
  const template = templates.find((item) => item.providerTemplateId === String(providerTemplateId));
  if (!template) throw new AppError('La plantilla no está aprobada o no pertenece al canal actual', 409);
  return template;
}

/**
 * Envía un mensaje con media (imagen/video) — al igual que sendMessage()
 * (texto libre), SÍ requiere que la ventana de 24h esté abierta.
 * @param {string} channelId
 * @param {string} to
 * @param {{ url: string, type: 'image'|'video', caption?: string }} media
 */
async function sendMedia(channelId, to, media, tenantId) {
  const channel = await loadOperationalChannel(channelId, tenantId);

  const provider = getProviderFor(channel);
  return provider.sendMedia(channel, to, media);
}

/**
 * Descarga el binario de un media ENTRANTE (imagen/video que un lead mandó)
 * a partir de la URL temporal que trae el payload del webhook.
 * @param {string} channelId
 * @param {string} mediaUrl
 * @returns {Promise<{ buffer: Buffer, contentType: string|null }>}
 */
async function downloadMedia(channelId, mediaUrl, tenantId) {
  const channel = await loadOperationalChannel(channelId, tenantId);

  const provider = getProviderFor(channel);
  return provider.downloadMedia(channel, mediaUrl);
}

/**
 * Estado operativo de un canal — Fase 1.1 (Provider Abstraction). Mismo
 * patrón de resolución que sendMessage(): recibe el ID, no el documento,
 * para mantener a ChannelService como la única puerta de entrada.
 * @param {string} channelId
 */
async function getChannelStatus(channelId, tenantId) {
  const channel = await loadOperationalChannel(channelId, tenantId);

  const provider = getProviderFor(channel);
  return provider.getChannelStatus(channel);
}

/**
 * @param {string} tenantId
 * @returns {Promise<Array>} canales activos del tenant
 */
async function getChannelForTenant(tenantId) {
  const channels = await channelRepository.findByTenant(tenantId);
  return channels.find((c) => c.status === 'active') || null;
}

/**
 * PR-10a — resuelve el canal de ENVÍO correcto para un mensaje saliente
 * dentro de una conversación puntual, en vez de "el primer canal activo del
 * tenant" a secas (getChannelForTenant(), arriba). Con 2+ canales activos
 * para el mismo tenant, ese comportamiento era ambiguo — no garantiza que
 * la respuesta salga por el MISMO canal por el que entró el mensaje del
 * lead (ver Conversation.whatsappChannel, conversation.model.js).
 *
 * Con 0 o 1 canal activo (100% de la base hoy), el resultado es IDÉNTICO al
 * de getChannelForTenant() en todos los casos — este cambio es
 * preventivo, no corrige nada que se haya observado roto todavía.
 *
 * @param {import('../ai/conversation.model')|null|undefined} conversation
 * @param {import('mongoose').Types.ObjectId|string} tenantId
 * @returns {Promise<import('./whatsappChannel.model')|null>}
 */
async function getChannelForConversation(conversation, tenantId) {
  if (!conversation || String(conversation.business) !== String(tenantId)) {
    throw new AppError('Conversación fuera del tenant solicitado', 403);
  }
  if (!conversation.whatsappChannel) {
    if (conversation._id) await Conversation.updateOne({ _id: conversation._id, business: tenantId }, { whatsappChannelStatus: 'reassignment_required' });
    throw new AppError('La conversación requiere asignar explícitamente un canal de WhatsApp', 409);
  }
  const channel = await channelRepository.findByIdForTenant(conversation.whatsappChannel, tenantId);
  if (!channel || channel.status !== 'active') {
    if (conversation._id) await Conversation.updateOne({ _id: conversation._id, business: tenantId }, { whatsappChannelStatus: 'reassignment_required' });
    logger.warn('[channelService] canal original no operativo; envío bloqueado hasta reasignación', { conversationId: String(conversation._id), channelId: String(conversation.whatsappChannel) });
    throw new AppError('El canal original no está operativo; la conversación requiere reasignación', 409);
  }
  return channel;
}

async function reassignConversationChannel({ conversationId, channelId, tenantId, actorId, reason }) {
  const channel = await channelRepository.findByIdForTenant(channelId, tenantId);
  if (!channel || channel.status !== 'active') throw new AppError('Canal de destino no encontrado o inactivo', 404);
  const conversation = await Conversation.findOne({ _id: conversationId, business: tenantId, isDeleted: false });
  if (!conversation) throw new AppError('Conversación no encontrada', 404);
  const previous = conversation.whatsappChannel || null;
  conversation.whatsappChannel = channel._id;
  conversation.whatsappChannelStatus = 'ready';
  conversation.whatsappChannelHistory.push({ from: previous, to: channel._id, changedBy: actorId, reason: reason || 'manual_reassignment' });
  await conversation.save();
  return conversation;
}

function listChannels(tenantId) {
  return channelRepository.findByTenant(tenantId);
}

module.exports = {
  sendMessage, sendTemplate, listTemplates, getTemplateCatalog, getApprovedTemplate, sendMedia, downloadMedia, getChannelStatus,
  getChannelForTenant, getChannelForConversation, listChannels,
  reassignConversationChannel,
  resolveTemplateVariables, resolveTemplateParams,
};
