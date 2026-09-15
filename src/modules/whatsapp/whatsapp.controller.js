const { respuestaExito } = require('../../utils/response');
const channelService = require('../channels/channel.service');

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

module.exports = { getStatus, getTemplates };
