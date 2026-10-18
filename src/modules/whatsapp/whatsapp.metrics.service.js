const mongoose = require('mongoose');
const Lead = require('../leads/lead.model');
const Conversation = require('../ai/conversation.model');
const logger = require('../../utils/logger');

/**
 * Datos reales para la tarjeta de WhatsApp de Conexiones (GET /whatsapp/status). Todo filtrado por el negocio del token.
 *
 *   connectedAt     fecha en que se guardó el canal (WhatsAppChannel.createdAt). La ve cualquiera que vea la pantalla.
 *   leadsReceived   leads del negocio con origen 'whatsapp', sin los eliminados (los archivados sí cuentan).
 *   lastActivityAt  el último mensaje ENTRANTE de cualquier conversación del negocio (máximo de lastInboundMessageAt).
 *
 * leadsReceived y lastActivityAt son métricas de TODO el negocio: solo se calculan si `negocioCompleto` (quien tiene leads:own
 * —p. ej. Ventas— solo ve sus propios leads y no debe ver el total). Sin dato o sin permiso devuelve null, nunca un 0 inventado;
 * un negocio sin leads de WhatsApp devuelve 0 de verdad. Si una consulta falla, ese dato queda en null y el estado del canal
 * no se rompe (es información secundaria).
 */
const obtenerMetricasDeWhatsapp = async (businessId, channel, { negocioCompleto = false } = {}) => {
  const metricas = {
    connectedAt: channel?.createdAt ? new Date(channel.createdAt).toISOString() : null,
    leadsReceived: null,
    lastActivityAt: null,
  };
  if (!negocioCompleto) return metricas;

  const negocio = new mongoose.Types.ObjectId(String(businessId));
  const [leads, ultimo] = await Promise.allSettled([
    Lead.countDocuments({ business: negocio, source: 'whatsapp', isDeleted: false }),
    Conversation.findOne({ business: negocio, isDeleted: false, lastInboundMessageAt: { $ne: null } })
      .sort({ lastInboundMessageAt: -1 })
      .select('lastInboundMessageAt')
      .lean(),
  ]);

  if (leads.status === 'fulfilled') metricas.leadsReceived = leads.value;
  else logger.warn('[whatsapp] No se pudo contar los leads de WhatsApp', { message: leads.reason?.message });

  if (ultimo.status === 'fulfilled') {
    metricas.lastActivityAt = ultimo.value?.lastInboundMessageAt ? new Date(ultimo.value.lastInboundMessageAt).toISOString() : null;
  } else {
    logger.warn('[whatsapp] No se pudo leer la última actividad de WhatsApp', { message: ultimo.reason?.message });
  }

  return metricas;
};

module.exports = { obtenerMetricasDeWhatsapp };
