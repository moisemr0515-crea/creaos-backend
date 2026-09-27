const OutboundEvent = require('./outboundEvent.model');
const Conversation = require('../ai/conversation.model');
const { enqueueOutbound } = require('./queues/outbound.queue');
const logger = require('../../utils/logger');

const DELIVERED_STATUSES = new Set(['enqueued', 'sent', 'delivered', 'read']);
const FAILED_STATUSES = new Set(['failed']);

function normalizeDeliveryReceipts(payload) {
  if (payload?.type === 'message-event' && payload.payload?.type) {
    const status = String(payload.payload.type).toLowerCase();
    if (!DELIVERED_STATUSES.has(status) && !FAILED_STATUSES.has(status)) return [];
    return [{
      providerMessageId: payload.payload.gsId || payload.payload.id || null,
      status,
      timestamp: payload.payload.ts || payload.timestamp || Date.now(),
    }];
  }

  if (payload?.object === 'whatsapp_business_account' && Array.isArray(payload.entry)) {
    const receipts = [];
    for (const entry of payload.entry) {
      for (const change of entry.changes || []) {
        for (const item of change.value?.statuses || []) {
          const status = String(item.status || '').toLowerCase();
          if (!DELIVERED_STATUSES.has(status) && !FAILED_STATUSES.has(status)) continue;
          receipts.push({
            providerMessageId: item.gsId || item.id || null,
            status,
            timestamp: item.timestamp || Date.now(),
          });
        }
      }
    }
    return receipts;
  }
  return [];
}

function isDeliveryReceipt(payload) {
  return normalizeDeliveryReceipts(payload).length > 0;
}

function toDate(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function syncManualMessage(event, status, error = null) {
  if (!event || event.origin !== 'manual') return;
  await Conversation.updateOne(
    {
      _id: event.conversation,
      business: event.tenantId,
      whatsappChannel: event.channel,
      'messages.outboundEventId': event._id,
    },
    {
      $set: {
        'messages.$.whatsappStatus': status,
        'messages.$.whatsappError': error,
      },
    }
  );
}

async function findTenantSafeEvent(providerMessageId) {
  const events = await OutboundEvent.find({ providerMessageId }).limit(2);
  if (events.length !== 1) return null;
  const [event] = events;
  const conversationMatches = await Conversation.exists({
    _id: event.conversation,
    business: event.tenantId,
    whatsappChannel: event.channel,
  });
  return conversationMatches ? event : null;
}

async function reconcileOne(receipt) {
  if (!receipt.providerMessageId) return null;
  const providerStatusAt = toDate(receipt.timestamp);
  const candidate = await findTenantSafeEvent(receipt.providerMessageId);
  if (!candidate) return null;

  if (DELIVERED_STATUSES.has(receipt.status)) {
    const event = await OutboundEvent.findOneAndUpdate(
      {
        _id: candidate._id,
        tenantId: candidate.tenantId,
        channel: candidate.channel,
        status: { $nin: ['permanently_failed', 'skipped'] },
      },
      {
        $set: {
          status: 'sent',
          providerStatus: receipt.status,
          providerStatusAt,
          sentAt: providerStatusAt,
          terminalAt: providerStatusAt,
          error: null,
          errorType: null,
        },
      },
      { new: true }
    );
    if (event) {
      await syncManualMessage(event, 'sent');
      logger.info('[outboundDelivery] receipt reconciliado como entregado', {
        outboundEventId: String(event._id),
        tenantId: String(event.tenantId),
        channelId: String(event.channel),
        provider: event.provider,
        providerStatus: receipt.status,
      });
    }
    return event;
  }

  const event = await OutboundEvent.findOneAndUpdate(
    {
      _id: candidate._id,
      tenantId: candidate.tenantId,
      channel: candidate.channel,
      status: { $in: ['delivery_uncertain', 'sending', 'sent'] },
      providerStatus: { $nin: ['delivered', 'read'] },
    },
    {
      $set: {
        status: 'retryable_failed',
        providerStatus: 'failed',
        providerStatusAt,
        error: 'El proveedor confirmó que el mensaje no fue entregado',
        errorType: 'provider_confirmed_failure',
        terminalAt: null,
      },
    },
    { new: true }
  );
  if (event) {
    await syncManualMessage(event, 'retryable_failed', event.error);
    await enqueueOutbound(event._id);
  }
  return event;
}

async function reconcileDeliveryReceipt(payload) {
  const receipts = normalizeDeliveryReceipts(payload);
  const results = [];
  for (const receipt of receipts) results.push(await reconcileOne(receipt));
  return results;
}

module.exports = {
  isDeliveryReceipt,
  normalizeDeliveryReceipts,
  reconcileDeliveryReceipt,
};
