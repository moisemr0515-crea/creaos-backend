const aiService = require('./ai.service');
const Conversation = require('./conversation.model');
const Lead = require('../leads/lead.model');
const Business = require('../businesses/business.model');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito, buildMeta } = require('../../utils/response');

/**
 * Verifica que el lead detrás de una conversación siga activo (existe y
 * isDeleted:false) antes de permitir una acción de escritura sobre esa
 * conversación. La Conversation NO se marca isDeleted en cascada cuando su
 * Lead se soft-deletea (son entidades independientes) — sigue 100%
 * funcional salvo este chequeo explícito. Sin esto, un conversationId
 * viejo (cacheado en el frontend, un tab abierto, etc.) que apunta a un
 * lead ya descartado como duplicado permite seguir escribiendo/enviando
 * sobre ESE lead — que puede no ser el que el usuario cree estar viendo.
 * Mismo criterio que ai.service.js#sendAgentMessage. Se llama ANTES de
 * cualquier escritura, para que un rechazo no deje nada guardado.
 */
const assertLeadActive = async (leadId) => {
  const lead = await Lead.findById(leadId, '_id isDeleted');
  if (!lead || lead.isDeleted) {
    throw new AppError('El lead asociado a esta conversación ya no existe o fue eliminado', 404);
  }
  return lead;
};

const startConversation = async (req, res, next) => {
  try {
    const { leadId, channel = 'manual' } = req.body;
    if (!leadId) throw new AppError('leadId es requerido', 400);

    const lead = await Lead.findOne({ _id: leadId, business: req.businessId, isDeleted: false });
    if (!lead) throw new AppError('Lead no encontrado', 404);

    // Reusar conversación activa si existe
    const existing = await Conversation.findOne({
      business: req.businessId,
      lead: leadId,
      status: 'active',
      isDeleted: false,
    });
    if (existing) {
      return respuestaExito(res, { message: 'Conversación activa encontrada', data: { conversation: existing } });
    }

    const conversation = await Conversation.create({
      business:   req.businessId,
      lead:       leadId,
      assignedTo: req.user._id,
      channel,
      status:     'active',
      aiEnabled:  true,
    });

    return respuestaExito(res, { statusCode: 201, message: 'Conversación iniciada exitosamente', data: { conversation } });
  } catch (err) {
    next(err);
  }
};

const sendMessage = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { message } = req.body;
    if (!message?.trim()) throw new AppError('El mensaje no puede estar vacío', 400);

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (!conversation.aiEnabled) throw new AppError('La IA está deshabilitada en esta conversación', 400);
    if (conversation.status === 'resolved') throw new AppError('La conversación ya está resuelta', 400);

    const [lead, business] = await Promise.all([
      Lead.findById(conversation.lead),
      Business.findById(req.businessId),
    ]);
    if (!lead || lead.isDeleted) {
      throw new AppError('El lead asociado a esta conversación ya no existe o fue eliminado', 404);
    }

    const result = await aiService.chat(conversationId, message, business, lead);

    return respuestaExito(res, { message: 'Respuesta generada exitosamente', data: result });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /:conversationId/agent-message
 * Un agente humano escribe un mensaje en el chat del CRM. A diferencia de
 * sendMessage (que simula lo que dijo el LEAD y pide la respuesta de la IA),
 * acá el texto ya es la respuesta — se guarda y, si la conversación es por
 * WhatsApp, se intenta despachar de verdad vía Gupshup. El scoping por
 * businessId pasa acá (no en el service, mismo patrón que sendMessage).
 */
const sendAgentMessage = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { message } = req.body;
    if (!message?.trim()) throw new AppError('El mensaje no puede estar vacío', 400);

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (conversation.status === 'resolved') throw new AppError('La conversación ya está resuelta', 400);

    const mensajeGuardado = await aiService.sendAgentMessage(conversationId, message, req.user);

    return respuestaExito(res, { message: 'Mensaje guardado', data: { message: mensajeGuardado } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /:conversationId/template-message
 * Envía una plantilla aprobada de WhatsApp Business — a diferencia de
 * agent-message (texto libre), esto NO requiere que la ventana de 24h esté
 * abierta: es justamente el mecanismo para reabrirla. El scoping por
 * businessId pasa acá, mismo patrón que sendAgentMessage.
 */
const sendTemplateMessage = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { templateId, params } = req.body;
    if (!templateId) throw new AppError('templateId es requerido', 400);

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (conversation.status === 'resolved') throw new AppError('La conversación ya está resuelta', 400);

    const mensajeGuardado = await aiService.sendTemplateMessage(conversationId, { id: templateId, params }, req.user);

    return respuestaExito(res, { message: 'Plantilla enviada', data: { message: mensajeGuardado } });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /:conversationId/media-message
 * Envía una imagen o video por WhatsApp — acepta multipart (campo `media`,
 * subido a Cloudinary acá) o una `mediaUrl` ya alojada (ej. el frontend
 * subió directo a Cloudinary del lado del cliente). Mismo scoping por
 * businessId que sendAgentMessage/sendTemplateMessage.
 */
const sendMediaMessage = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { mediaUrl, mediaType, caption } = req.body;
    if (!req.file && !mediaUrl) {
      throw new AppError('Se requiere un archivo (media) o una mediaUrl ya alojada', 400);
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (conversation.status === 'resolved') throw new AppError('La conversación ya está resuelta', 400);

    const mensajeGuardado = await aiService.sendMediaMessage(
      conversationId,
      {
        file: req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype } : undefined,
        mediaUrl,
        mediaType,
        caption,
      },
      req.user
    );

    return respuestaExito(res, { message: 'Media enviada', data: { message: mensajeGuardado } });
  } catch (err) {
    next(err);
  }
};

const getConversation = async (req, res, next) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.conversationId,
      business: req.businessId,
      isDeleted: false,
    })
      .populate('lead', 'name email company temperature pipelineStage potentialValue')
      .populate('assignedTo', 'name email avatar');

    if (!conversation) throw new AppError('Conversación no encontrada', 404);

    // Ventana de 24h de WhatsApp Business (Meta) — el frontend la necesita
    // para decidir si mostrar el compositor de texto libre o forzar una
    // plantilla, sin tener que pedirla aparte.
    const { windowOpen, windowExpiresAt } = conversation.getWindowState();

    return respuestaExito(res, {
      message: 'Conversación obtenida exitosamente',
      data: { conversation, windowOpen, windowExpiresAt },
    });
  } catch (err) {
    next(err);
  }
};

const listConversations = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, leadId, channel } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query = { business: req.businessId, isDeleted: false };
    if (status)  query.status = status;
    if (leadId)  query.lead = leadId;
    if (channel) query.channel = channel;

    const [conversations, total] = await Promise.all([
      Conversation.find(query)
        .populate('lead', 'name email company temperature')
        .populate('assignedTo', 'name email')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .select('-messages'),
      Conversation.countDocuments(query),
    ]);

    return respuestaExito(res, {
      message: 'Conversaciones obtenidas exitosamente',
      data: { conversations },
      meta: buildMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
};

const qualifyLead = async (req, res, next) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (conversation.messages.length < 2) {
      throw new AppError('Se necesitan al menos 2 mensajes para calificar al lead', 400);
    }

    const lead = await Lead.findById(conversation.lead);
    if (!lead || lead.isDeleted) {
      throw new AppError('El lead asociado a esta conversación ya no existe o fue eliminado', 404);
    }
    const qualification = await aiService.qualifyLead(conversationId, lead);

    return respuestaExito(res, { message: 'Lead calificado exitosamente', data: { qualification } });
  } catch (err) {
    next(err);
  }
};

const getSummary = async (req, res, next) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (conversation.messages.length < 2) {
      throw new AppError('Se necesitan al menos 2 mensajes para generar un resumen', 400);
    }
    await assertLeadActive(conversation.lead);

    const summary = await aiService.generateSummary(conversationId);

    return respuestaExito(res, { message: 'Resumen generado exitosamente', data: { summary } });
  } catch (err) {
    next(err);
  }
};

const suggestResponse = async (req, res, next) => {
  try {
    const { leadId, context } = req.body;
    if (!leadId || !context) throw new AppError('leadId y context son requeridos', 400);

    const lead = await Lead.findOne({ _id: leadId, business: req.businessId, isDeleted: false });
    if (!lead) throw new AppError('Lead no encontrado', 404);

    const suggestions = await aiService.suggestResponse(leadId, context);

    return respuestaExito(res, { message: 'Sugerencias generadas exitosamente', data: { suggestions } });
  } catch (err) {
    next(err);
  }
};

const toggleAI = async (req, res, next) => {
  try {
    const { conversationId } = req.params;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    await assertLeadActive(conversation.lead);

    conversation.aiEnabled = !conversation.aiEnabled;
    await conversation.save();

    return respuestaExito(res, {
      message: `IA ${conversation.aiEnabled ? 'activada' : 'desactivada'} exitosamente`,
      data: { aiEnabled: conversation.aiEnabled, conversationId },
    });
  } catch (err) {
    next(err);
  }
};

const escalate = async (req, res, next) => {
  try {
    const { conversationId } = req.params;
    const { reason } = req.body;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      business: req.businessId,
      isDeleted: false,
    });
    if (!conversation) throw new AppError('Conversación no encontrada', 404);
    if (conversation.status === 'escalated') {
      throw new AppError('La conversación ya está escalada', 400);
    }
    await assertLeadActive(conversation.lead);

    conversation.status = 'escalated';
    conversation.escalatedAt = new Date();
    conversation.aiEnabled = false;
    if (reason) {
      conversation.messages.push({
        role: 'system',
        content: `Conversación escalada a humano. Motivo: ${reason}`,
        timestamp: new Date(),
      });
    }
    await conversation.save();

    return respuestaExito(res, {
      message: 'Conversación escalada a agente humano',
      data: { conversation },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  startConversation,
  sendMessage,
  sendAgentMessage,
  sendTemplateMessage,
  sendMediaMessage,
  getConversation,
  listConversations,
  qualifyLead,
  getSummary,
  suggestResponse,
  toggleAI,
  escalate,
};
