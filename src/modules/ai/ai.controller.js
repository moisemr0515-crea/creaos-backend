const aiService = require('./ai.service');
const Conversation = require('./conversation.model');
const Lead = require('../leads/lead.model');
const Business = require('../businesses/business.model');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito, buildMeta } = require('../../utils/response');

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

    const result = await aiService.chat(conversationId, message, business, lead);

    return respuestaExito(res, { message: 'Respuesta generada exitosamente', data: result });
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

    return respuestaExito(res, { message: 'Conversación obtenida exitosamente', data: { conversation } });
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
  getConversation,
  listConversations,
  qualifyLead,
  getSummary,
  suggestResponse,
  toggleAI,
  escalate,
};
