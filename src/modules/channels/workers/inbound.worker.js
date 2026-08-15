const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { moveToDeadLetter } = require('../queues/deadLetter.queue');
const { enqueueOutbound } = require('../queues/outbound.queue');
const InboundEvent = require('../inboundEvent.model');
const OutboundEvent = require('../outboundEvent.model');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const Conversation = require('../../ai/conversation.model');
const DefaultAgentRuntime = require('../defaultAgentRuntime');
const logger = require('../../../utils/logger');

/**
 * inbound.worker.js — sub-fase 1.d. Consume whatsapp-inbound (solo cuando
 * WHATSAPP_QUEUE_PROCESSING_ENABLED=true).
 *
 * NOTA DE DISEÑO IMPORTANTE (opción B, aprobada explícitamente): la lógica
 * de buscar/crear Lead y Conversation de abajo es una DUPLICACIÓN deliberada
 * de webhook.service.js#processGupshupMessage() (líneas ~363-403 de ese
 * archivo) — NO se extrajo a un helper compartido a propósito, para no
 * tocar ni una línea de la función que corre hoy en el flujo síncrono
 * (1.c). Es deuda técnica reconocida: cuando el flujo síncrono se retire
 * (limpieza futura, mismo espíritu que la sub-fase 1.f), esta duplicación
 * se puede consolidar. Hasta entonces, un bug en un lado no afecta al otro.
 *
 * A diferencia de processGupshupMessage(), acá la llamada a la IA pasa por
 * AgentRuntime.process() (DefaultAgentRuntime), no por aiService.chat()
 * directo — ver agentRuntime.interface.js.
 */

const agentRuntime = new DefaultAgentRuntime();

async function ensureLeadAndConversation({ businessId, phone, text, name }) {
  const business = await Business.findById(businessId);
  if (!business) throw new Error(`Business ${businessId} no encontrado`);

  let lead = await Lead.findOne({ business: businessId, phone, isDeleted: false });
  if (!lead) {
    lead = await Lead.create({
      business: businessId,
      name: name || phone,
      phone,
      source: 'whatsapp',
      whatsappId: phone,
      tags: ['whatsapp'],
      activity: [{ type: 'created', description: `Mensaje WhatsApp recibido: ${text.slice(0, 100)}` }],
    });
  } else {
    lead.activity.push({ type: 'contacted', description: `WhatsApp: ${text.slice(0, 100)}` });
    lead.lastContactedAt = new Date();
    await lead.save();
  }

  let conversation = await Conversation.findOne({ business: businessId, lead: lead._id, status: 'active', isDeleted: false });
  if (!conversation) {
    conversation = await Conversation.create({ business: businessId, lead: lead._id, channel: 'whatsapp', status: 'active', aiEnabled: true });
  }

  return { business, lead, conversation };
}

async function processInboundJob(job) {
  const { inboundEventId } = job.data;
  const event = await InboundEvent.findById(inboundEventId);
  if (!event) throw new Error(`InboundEvent ${inboundEventId} no encontrado`);

  event.status = 'processing';
  await event.save();

  const { business, lead, conversation } = await ensureLeadAndConversation({
    businessId: event.tenantId,
    phone: event.from,
    text: event.text,
    name: event.rawPayload?.name,
  });

  if (!conversation.aiEnabled) {
    logger.info('[inboundWorker] IA deshabilitada para esta conversación, no se responde', { conversationId: conversation._id.toString() });
    event.status = 'processed';
    event.processedAt = new Date();
    await event.save();
    return;
  }

  const businessContext = {
    name: business.name,
    productDescription: business.productDescription,
    targetCustomer: business.targetCustomer,
    pdfSummary: business.pdfSummary,
    pdfExtractedText: business.pdfExtractedText, // agregado más allá del contrato literal del Blueprint — ver resumen de plan de 1.d
    aiInstructions: business.aiInstructions,
  };

  const output = await agentRuntime.process({
    tenantId: String(event.tenantId),
    channelId: String(event.channel),
    conversationId: String(conversation._id),
    leadId: String(lead._id),
    message: { text: event.text, providerMessageId: event.providerMessageId, timestamp: event.receivedAt },
    businessContext,
    conversationHistory: conversation.messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
  });

  if (output.reply) {
    const outboundEvent = await OutboundEvent.create({
      channel: event.channel,
      tenantId: event.tenantId,
      conversation: conversation._id,
      to: event.from,
      text: output.reply,
      status: 'pending',
    });
    await enqueueOutbound(outboundEvent._id);
  }

  event.status = 'processed';
  event.processedAt = new Date();
  await event.save();
}

function startInboundWorker() {
  const worker = new Worker(
    QUEUE_NAMES.INBOUND,
    async (job) => {
      try {
        await processInboundJob(job);
      } catch (err) {
        logger.error('[inboundWorker] error procesando job', { jobId: job.id, error: err.message, stack: err.stack });
        throw err; // deja que BullMQ reintente según DEFAULT_JOB_OPTIONS
      }
    },
    { connection: getQueueConnection(), concurrency: 5 }
  );

  worker.on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      await moveToDeadLetter(QUEUE_NAMES.INBOUND, job.data, err.message).catch((e) =>
        logger.error('[inboundWorker] no se pudo mover a dead letter', { error: e.message })
      );
      // Refleja el agotamiento de reintentos en el InboundEvent también, no
      // solo en la dead letter queue — para que quede visible desde Mongo.
      await InboundEvent.findByIdAndUpdate(job.data.inboundEventId, { status: 'failed', error: err.message }).catch(() => {});
    }
  });

  return worker;
}

module.exports = { startInboundWorker, processInboundJob, ensureLeadAndConversation };
