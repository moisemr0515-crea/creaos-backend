const { Worker } = require('bullmq');
const { getQueueConnection, QUEUE_NAMES } = require('../../../config/queue');
const { moveToDeadLetter } = require('../queues/deadLetter.queue');
const { enqueueOutbound } = require('../queues/outbound.queue');
const InboundEvent = require('../inboundEvent.model');
const OutboundEvent = require('../outboundEvent.model');
const Business = require('../../businesses/business.model');
const Lead = require('../../leads/lead.model');
const leadService = require('../../leads/lead.service');
const Conversation = require('../../ai/conversation.model');
const aiService = require('../../ai/ai.service');
const notificationService = require('../../admin/notification.service');
const pushService = require('../../push/push.service');
const DefaultAgentRuntime = require('../defaultAgentRuntime');
const { normalizeToE164 } = require('../../../utils/phone');
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

/**
 * Devuelve null (no throw) en los mismos 2 casos borde que
 * webhook.service.js#processGupshupMessage() trata como no-op silencioso
 * (phone/text vacío, business no encontrado) — hallazgo de code review: la
 * duplicación original no tenía estos guards y divergía del comportamiento
 * ya probado del flujo síncrono (throw + reintentos + dead-letter en vez de
 * un no-op consistente).
 */
async function ensureLeadAndConversation({ businessId, phone, text, name, mediaType, mediaSourceUrl, channelId = null }) {
  // Mismo criterio que webhook.service.js#processGupshupMessage(): un
  // mensaje de imagen/video sin caption llega con text:'' — antes este
  // guard exigía `text` siempre, así que el caso más común (una foto sola,
  // sin escribir nada) se descartaba acá, aunque hubiera media real.
  if (!phone || (!text && !mediaSourceUrl)) {
    logger.warn('[inboundWorker] phone vacío y sin texto ni media, se descarta', { businessId, phone, text });
    return null;
  }

  const business = await Business.findById(businessId);
  if (!business) {
    logger.warn('[inboundWorker] business no encontrado', { businessId });
    return null;
  }

  // Mismo bug y mismo fix que webhook.service.js#processGupshupMessage():
  // el phone que manda Gupshup viene crudo (sin "+"), pero todo Lead se
  // guarda normalizado a E.164 por el pre('save') de lead.model.js — sin
  // normalizar acá también, este findOne nunca encontraba al lead ya
  // existente y terminaba intentando crear uno duplicado (E11000 desde el
  // índice único de Paso 3). Duplicación deliberada de esa función (ver
  // nota de diseño arriba) — se corrige acá también, no se extrae a un
  // helper compartido, mismo criterio que el resto de este archivo.
  const phoneNormalizado = normalizeToE164(phone);
  let lead = await Lead.findOne({ business: businessId, phone: phoneNormalizado, isDeleted: false });

  // Mensaje de imagen/video sin caption -> text:'' — mismo fallback legible
  // que webhook.service.js#processGupshupMessage().
  const resumenActividad = text?.slice(0, 100) || (mediaType ? `[${mediaType}]` : '');

  if (!lead) {
    lead = await Lead.create({
      business: businessId,
      name: name || phoneNormalizado,
      phone: phoneNormalizado,
      source: 'whatsapp',
      whatsappId: phoneNormalizado,
      tags: ['whatsapp'],
      activity: [{ type: 'created', description: `Mensaje WhatsApp recibido: ${resumenActividad}` }],
    });

    // Fail-soft de plan (auditoría de pricing del 23/ago/2026) — nunca
    // bloquea, solo marca/avisa. Ver comentario completo en
    // webhook.service.js#processMetaLead().
    leadService.notifyIfOverLeadLimit(lead).catch(() => {});
  } else {
    lead.activity.push({ type: 'contacted', description: `WhatsApp: ${resumenActividad}` });
    lead.lastContactedAt = new Date();
    await lead.save();
  }

  let conversation = await Conversation.findOne({ business: businessId, lead: lead._id, status: 'active', isDeleted: false });
  if (!conversation) {
    // PR-10a: whatsappChannel = channelId (el WhatsAppChannel real que
    // recibió este mensaje, ya resuelto por channelResolver.resolve() en
    // inbound.gateway.js antes de encolar) — mismo criterio que
    // webhook.service.js#processGupshupMessage().
    conversation = await Conversation.create({ business: businessId, lead: lead._id, channel: 'whatsapp', whatsappChannel: channelId, status: 'active', aiEnabled: true });
  }

  // Ventana de 24h de WhatsApp Business (Meta) — mismo criterio que
  // webhook.service.js#processGupshupMessage(): SOLO un WhatsApp entrante
  // real la abre/renueva. Se actualiza siempre, independiente de aiEnabled.
  conversation.lastInboundMessageAt = new Date();
  await conversation.save();

  return { business, lead, conversation };
}

async function processInboundJob(job) {
  const { inboundEventId } = job.data;
  const event = await InboundEvent.findById(inboundEventId);
  if (!event) throw new Error(`InboundEvent ${inboundEventId} no encontrado`);

  // Idempotencia ante reintentos de BullMQ (hallazgo de code review): si ya
  // existe un OutboundEvent generado a partir de este InboundEvent, un
  // intento anterior de este mismo job ya llamó a la IA y encoló la
  // respuesta — probablemente falló al guardar el estado final, no al
  // generar la respuesta. No se vuelve a llamar a la IA ni se crea una
  // segunda respuesta para el mismo mensaje entrante.
  const existingOutbound = await OutboundEvent.findOne({ sourceInboundEvent: event._id });
  if (existingOutbound) {
    logger.info('[inboundWorker] ya existe una respuesta generada para este InboundEvent (reintento), no se reprocesa', { inboundEventId, outboundEventId: existingOutbound._id.toString() });
    event.status = 'processed';
    event.processedAt = event.processedAt || new Date();
    await event.save();
    return;
  }

  event.status = 'processing';
  await event.save();

  const result = await ensureLeadAndConversation({
    businessId: event.tenantId,
    phone: event.from,
    text: event.text,
    name: event.rawPayload?.name,
    mediaType: event.mediaType,
    mediaSourceUrl: event.mediaSourceUrl,
    // PR-10a: event.channel ya viene resuelto por channelResolver.resolve()
    // (inbound.gateway.js, antes de encolar este InboundEvent).
    channelId: event.channel,
  });

  if (!result) {
    // Mismo criterio que processGupshupMessage(): phone/text vacío o
    // business no encontrado es un no-op silencioso, no un fallo — se
    // marca 'processed' (no 'failed'), sin reintentos ni dead-letter.
    event.status = 'processed';
    event.processedAt = new Date();
    await event.save();
    return;
  }

  const { business, lead, conversation } = result;

  // Guarda el mensaje entrante SIEMPRE, sin importar si la IA va a
  // responder — mismo criterio y mismo motivo que
  // webhook.service.js#processGupshupMessage() (ver ai.service.js#
  // saveInboundMessage()). Este camino no está activo en producción todavía
  // (WHATSAPP_QUEUE_PROCESSING_ENABLED=false), pero tenía la misma bomba: un
  // mensaje real solo se guardaba como efecto colateral de que la IA
  // respondiera. Si el evento trae media (imagen/video), saveInboundMessage()
  // la descarga de la URL temporal de Gupshup y la re-aloja en Cloudinary —
  // mismo criterio que processGupshupMessage() (feat/inbound-media-messages).
  await aiService.saveInboundMessage(
    conversation._id,
    event.text,
    event.mediaSourceUrl ? { mediaType: event.mediaType, sourceUrl: event.mediaSourceUrl } : undefined
  );

  if (!conversation.aiEnabled) {
    logger.info('[inboundWorker] IA deshabilitada para esta conversación, no se responde', { conversationId: conversation._id.toString() });

    // PR-C — mismo disparador ("lead_message") que
    // webhook.service.js#processGupshupMessage(). Portado (Track 1 #5,
    // auditoría de pricing del 24/ago/2026) — antes solo notificaba a
    // lead.assignedTo, en silencio si estaba vacío (el caso más común para
    // un lead nuevo de WhatsApp). Mismo fallback ya validado en producción
    // del lado legacy: leadService.resolveNotificationRecipients(lead) —
    // assignedTo si existe, si no, todos los owner/admin activos del
    // negocio. Cada destinatario y cada canal en su propio try/catch,
    // fail-soft — un fallo acá nunca debe impedir que se avise al resto.
    const destinatarios = await leadService.resolveNotificationRecipients(lead);
    if (destinatarios.length > 0) {
      const previewTexto = event.text.slice(0, 150);

      for (const userId of destinatarios) {
        try {
          await notificationService.createNotification({
            business: business._id,
            user: userId,
            type: 'info',
            category: 'lead',
            title: `Nuevo mensaje de ${lead.name}`,
            message: previewTexto,
            meta: { leadId: lead._id, conversationId: conversation._id, event: 'lead_message' },
          });
        } catch (err) {
          logger.error('[inboundWorker] createNotification() falló para lead_message', {
            leadId: lead._id.toString(),
            userId: userId.toString(),
            error: err.message,
          });
        }

        try {
          await pushService.sendToUser(userId, {
            title: `Nuevo mensaje de ${lead.name}`,
            body: previewTexto,
            data: { type: 'lead_message', leadId: String(lead._id), conversationId: String(conversation._id) },
          });
        } catch (err) {
          logger.error('[inboundWorker] sendToUser() falló para lead_message', {
            leadId: lead._id.toString(),
            userId: userId.toString(),
            error: err.message,
          });
        }
      }
    }

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
      sourceInboundEvent: event._id,
      to: event.from,
      text: output.reply,
      status: 'pending',
    });
    await enqueueOutbound(outboundEvent._id);

    // Portado de webhook.service.js#processGupshupMessage() (Track 1 #5,
    // auditoría de pricing del 24/ago/2026). Mismo criterio: fire-and-forget,
    // no durable a propósito (ver docs/implementation/known-issues.md para
    // el criterio general de esta sesión sobre qué SÍ necesita BullMQ) — si
    // el proceso muere a mitad, se pierde sin rastro, y el próximo mensaje
    // real del lead vuelve a disparar este mismo camino con el historial
    // más completo. El punto análogo a "el reply ya salió por WhatsApp" del
    // lado legacy (que espera a channelService.sendMessage() síncrono) es
    // acá, justo después de encolar el OutboundEvent — este flujo no tiene
    // un paso de envío síncrono que esperar.
    aiService.qualifyLead(conversation._id, lead).catch((err) => {
      logger.error('[inboundWorker] qualifyLead() automático post-respuesta falló (no afecta el reply ya encolado)', {
        conversationId: conversation._id.toString(),
        leadId: lead._id.toString(),
        error: err.message,
      });
    });
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
