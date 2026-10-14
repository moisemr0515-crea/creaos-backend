const notificationService = require('../admin/notification.service');
const pushService = require('../push/push.service');
const logger = require('../../utils/logger');

/**
 * Crea la evidencia in-app y dispara push desde el mismo evento inbound.
 * La creación idempotente de Notification es la compuerta del push: una
 * reentrega del mismo InboundEvent no vuelve a mandar FCM.
 */
async function notifyInboundLeadMessage({
  businessId,
  lead,
  conversation,
  text,
  mediaType = null,
  inboundEventId = null,
  providerMessageId = null,
  recipientUserIds = [],
}) {
  const sourceId = String(inboundEventId || providerMessageId || `${conversation._id}:${conversation.messages.length}`);
  const correlationId = `inbound:${sourceId}`;
  const preview = text?.slice(0, 150) || (mediaType ? `[${mediaType}]` : 'Nuevo mensaje');
  const results = [];

  for (const userId of recipientUserIds) {
    const deduplicationKey = `lead_message:${sourceId}:${userId}`;
    try {
      const { notification, created } = await notificationService.createNotificationOnce({
        business: businessId,
        user: userId,
        type: 'info',
        category: 'lead',
        title: `Nuevo mensaje de ${lead.name}`,
        message: preview,
        deduplicationKey,
        meta: {
          leadId: lead._id,
          conversationId: conversation._id,
          event: 'lead_message',
          correlationId,
          ...(inboundEventId ? { inboundEventId } : {}),
          ...(providerMessageId ? { providerMessageId } : {}),
        },
      });

      if (!created) {
        logger.info('[inboundNotification] evento ya notificado, push omitido por idempotencia', {
          correlationId,
          tenantId: String(businessId),
          userId: String(userId),
          notificationId: String(notification._id),
        });
        results.push({ userId, created: false, pushed: false });
        continue;
      }

      const push = await pushService.sendToUser(userId, {
        title: `Nuevo mensaje de ${lead.name}`,
        body: preview,
        tenantId: businessId,
        correlationId,
        eventType: 'lead_message',
        data: {
          type: 'lead_message',
          leadId: String(lead._id),
          conversationId: String(conversation._id),
        },
      });
      results.push({ userId, created: true, pushed: push.sent > 0, push });
    } catch (err) {
      // El mensaje ya está persistido. Un fallo de notificación nunca debe
      // hacer perder/reprocesar el inbound ni bloquear la respuesta IA.
      logger.error('[inboundNotification] no se pudo notificar lead_message', {
        correlationId,
        tenantId: String(businessId),
        userId: String(userId),
        error: err.message,
        errorCode: err.code || null,
      });
      results.push({ userId, created: false, pushed: false, error: err.code || err.message });
    }
  }

  return { correlationId, recipients: results };
}

module.exports = { notifyInboundLeadMessage };
