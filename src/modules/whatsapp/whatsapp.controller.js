const WhatsAppConnection = require('./whatsappConnection.model');
const { AppError } = require('../../middleware/error.middleware');
const { respuestaExito } = require('../../utils/response');
const logger = require('../../utils/logger');
const channelService = require('../channels/channel.service');

// ─── POST /api/v1/whatsapp/connections ───────────────────────────────────────

const createConnection = async (req, res, next) => {
  try {
    throw new AppError('Este endpoint legacy fue retirado. Usa Embedded Signup para crear un canal real.', 410);
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/whatsapp/connections ────────────────────────────────────────

const listConnections = async (req, res, next) => {
  try {
    const connections = await WhatsAppConnection.find({ business: req.businessId }).sort({ createdAt: -1 }).lean();

    return respuestaExito(res, {
      message: 'Conexiones de WhatsApp obtenidas',
      data: { connections: connections.map((item) => ({ ...item, status: item.status === 'connected' ? 'legacy_simulated' : item.status, operational: false })) },
    });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/v1/whatsapp/connections/:id ─────────────────────────────────

const disconnectConnection = async (req, res, next) => {
  try {
    const connection = await WhatsAppConnection.findOneAndUpdate(
      { _id: req.params.id, business: req.businessId },
      { $set: { status: 'disconnected' } },
      { new: true }
    );

    if (!connection) throw new AppError('Conexión no encontrada', 404);

    logger.info('[whatsapp] Conexión desconectada', {
      businessId: req.businessId.toString(),
      userId: req.user?._id?.toString(),
      connectionId: connection._id.toString(),
    });

    return respuestaExito(res, {
      message: 'Conexión de WhatsApp desconectada',
      data: { connection },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/whatsapp/status ──────────────────────────────────────────────
// Fase 1.1 (Provider Abstraction): reemplaza la llamada directa a
// gupshup.client.js#estaConfigurado() por channelService, resuelto por el
// WhatsAppChannel real del tenant — ya no asume un canal compartido
// implícito (Fix 2 del Caso 8, comportamiento anterior). CAMBIO DE
// COMPORTAMIENTO INTENCIONAL: antes este endpoint devolvía connected:true
// para CUALQUIER negocio con las env vars de Gupshup configuradas, sin
// importar si ese negocio tenía o no un WhatsAppChannel propio — ahora
// devuelve connected:false para cualquier tenant sin un WhatsAppChannel
// activo, que es el resultado correcto según el objetivo de Fase 1 (cada
// canal pertenece a un tenant real, ninguno hereda un canal compartido por
// default). Confirmado y aprobado explícitamente, no es una regresión.

const getStatus = async (req, res, next) => {
  try {
    const channel = await channelService.getChannelForTenant(req.businessId);
    if (!channel) {
      return respuestaExito(res, {
        message: 'Estado del canal de WhatsApp obtenido',
        data: { connected: false, provider: 'gupshup', phoneNumber: null },
      });
    }

    const status = await channelService.getChannelStatus(channel._id, req.businessId);

    return respuestaExito(res, {
      message: 'Estado del canal de WhatsApp obtenido',
      data: status,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/v1/whatsapp/templates ────────────────────────────────────────
// Plantillas aprobadas de WhatsApp Business para el canal del tenant — para
// reabrir la ventana de 24h con un mensaje de texto libre. Proxy en vivo a
// Gupshup (sin tabla local todavía) — mismo patrón de resolución que
// getStatus(): sin WhatsAppChannel activo, no hay nada que listar.

const getTemplates = async (req, res, next) => {
  try {
    const channel = await channelService.getChannelForTenant(req.businessId);
    if (!channel) {
      return respuestaExito(res, {
        message: 'Plantillas de WhatsApp obtenidas',
        data: { templates: [] },
      });
    }

    const templates = await channelService.listTemplates(channel._id, req.businessId);

    return respuestaExito(res, {
      message: 'Plantillas de WhatsApp obtenidas',
      data: { templates },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { createConnection, listConnections, disconnectConnection, getStatus, getTemplates };
