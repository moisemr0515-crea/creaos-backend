const crypto = require('crypto');
const Lead = require('../leads/lead.model');
const WebhookConfig = require('./webhookConfig.model');
const Conversation = require('../ai/conversation.model');
const Business = require('../businesses/business.model');
const aiService = require('../ai/ai.service');
const channelService = require('../channels/channel.service');
const notificationService = require('../admin/notification.service');
const pushService = require('../push/push.service');
const leadService = require('../leads/lead.service');
const { normalizeToE164 } = require('../../utils/phone');
const logger = require('../../utils/logger');
const {
  META_APP_SECRET,
  META_GRAPH_API_VERSION,
  TIKTOK_APP_SECRET,
  GUPSHUP_WEBHOOK_TOKEN,
  NODE_ENV,
} = require('../../config/env');

const GUPSHUP_WEBHOOK_HEADER = 'x-gupshup-webhook-token';

// ─── Meta signature verification (también usada por WhatsApp Cloud API) ──────

function verifyMetaSignature(rawBody, signature, secret = META_APP_SECRET) {
  if (NODE_ENV !== 'production' && !secret) return true;
  if (!secret || !rawBody || !signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Gupshup custom-header token verification ────────────────────────────────
// Gupshup no ofrece HMAC ni Basic Auth — su panel (Webhook config → Custom Header)
// solo permite definir un par header/valor libre que reenvía en cada request.
// Configurar ahí el header "X-Gupshup-Webhook-Token" con el mismo valor que GUPSHUP_WEBHOOK_TOKEN.

function verifyGupshupAuth(headers) {
  if (NODE_ENV !== 'production' && !GUPSHUP_WEBHOOK_TOKEN) return true;
  if (!GUPSHUP_WEBHOOK_TOKEN) return false;

  const received = headers?.[GUPSHUP_WEBHOOK_HEADER] || '';
  if (!received) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(GUPSHUP_WEBHOOK_TOKEN));
  } catch {
    return false;
  }
}

// ─── TikTok signature verification ───────────────────────────────────────────

function verifyTikTokSignature(rawBody, timestamp, nonce, signature) {
  if (NODE_ENV !== 'production' && !TIKTOK_APP_SECRET) return true;
  if (!TIKTOK_APP_SECRET || !rawBody || !signature) return false;

  const str = [TIKTOK_APP_SECRET, timestamp, nonce, rawBody].sort().join('');
  const expected = crypto.createHash('sha256').update(str).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Meta Graph API ───────────────────────────────────────────────────────────

async function fetchMetaLead(leadId, accessToken) {
  const version = META_GRAPH_API_VERSION || 'v19.0';
  const url = `https://graph.facebook.com/${version}/${leadId}?fields=field_data,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id&access_token=${accessToken}`;
  const response = await fetch(url);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Meta Graph API error: ${err.error?.message || response.statusText}`);
  }
  return response.json();
}

// ─── Meta field mapping ───────────────────────────────────────────────────────

function mapMetaFieldsToLead(fieldData) {
  const map = {};
  for (const { name, values } of fieldData) {
    map[name.toLowerCase()] = values?.[0] || '';
  }
  return {
    name:    map['full_name'] || map['nombre_completo'] || map['name'] || '',
    email:   map['email'] || map['correo'] || map['correo_electronico'] || '',
    phone:   map['phone_number'] || map['telefono'] || map['phone'] || '',
    company: map['company_name'] || map['empresa'] || map['company'] || '',
  };
}

// ─── Process a Meta lead gen notification ────────────────────────────────────

async function processMetaLead(entry, config) {
  const results = [];

  for (const change of entry.changes || []) {
    if (change.field !== 'leadgen') continue;
    const { leadgen_id: leadgenId, form_id: formId, page_id: pageId } = change.value;

    // Filter by formId whitelist if configured
    if (config.formIds?.length && !config.formIds.includes(formId)) continue;

    // Fetch full lead data from Meta Graph API
    let leadData;
    try {
      leadData = await fetchMetaLead(leadgenId, config.accessToken);
    } catch (err) {
      results.push({ leadgenId, status: 'error', error: err.message });
      continue;
    }

    const mapped = mapMetaFieldsToLead(leadData.field_data || []);

    // Skip if no name or email
    if (!mapped.name && !mapped.email) {
      results.push({ leadgenId, status: 'skipped', reason: 'no_identifiable_data' });
      continue;
    }

    // Duplicate check by email
    if (mapped.email) {
      const existing = await Lead.findOne({
        business: config.business,
        email: mapped.email,
        isDeleted: false,
      });
      if (existing) {
        results.push({ leadgenId, status: 'duplicate', leadId: existing._id });
        continue;
      }
    }

    const lead = await Lead.create({
      business:      config.business,
      name:          mapped.name,
      email:         mapped.email || undefined,
      phone:         mapped.phone || undefined,
      company:       mapped.company || undefined,
      source:        config.defaults?.source || 'facebook',
      pipelineStage: config.defaults?.pipelineStage || 'new',
      temperature:   config.defaults?.temperature || 'warm',
      assignedTo:    config.defaults?.assignedTo || undefined,
      tags:          config.defaults?.tags || [],
      adSource: {
        platform:     'meta',
        campaignId:   leadData.campaign_id,
        campaignName: leadData.campaign_name,
        adSetId:      leadData.adset_id,
        adSetName:    leadData.adset_name,
        adId:         leadData.ad_id,
        adName:       leadData.ad_name,
        formId:       formId,
        pageId:       pageId,
        leadgenId:    leadgenId,
        receivedAt:   new Date(),
      },
    });

    // Fail-soft de plan (auditoría de pricing del 23/ago/2026) — nunca
    // bloquea la creación, solo marca/avisa si el negocio ya está sobre
    // su límite de leads activos.
    leadService.notifyIfOverLeadLimit(lead).catch(() => {});

    // Mismo criterio que crearLead()/procesarImportacion(): un lead que
    // llega por publicidad no pasa por ningún flujo que le cree una
    // Conversation por su cuenta (eso solo pasa con un mensaje de
    // WhatsApp entrante) — se crea acá para que el panel de chat tenga un
    // conversationId listo para usar de entrada.
    await Conversation.create({
      business:  config.business,
      lead:      lead._id,
      channel:   'manual',
      status:    'active',
      aiEnabled: true,
    });

    await WebhookConfig.updateOne(
      { _id: config._id },
      { $inc: { totalLeadsReceived: 1 }, $set: { lastReceivedAt: new Date() } }
    );

    results.push({ leadgenId, status: 'created', leadId: lead._id });
  }

  return results;
}

// ─── TikTok field mapping ─────────────────────────────────────────────────────

function mapTikTokFieldsToLead(fields) {
  const map = {};
  for (const { name, value } of fields) {
    map[name.toUpperCase()] = value || '';
  }
  return {
    name:    map['FULL_NAME'] || map['NAME'] || map['NOMBRE'] || '',
    email:   map['EMAIL'] || map['CORREO'] || '',
    phone:   map['PHONE_NUMBER'] || map['PHONE'] || map['TELEFONO'] || '',
    company: map['COMPANY_NAME'] || map['COMPANY'] || map['EMPRESA'] || '',
  };
}

// ─── Process a TikTok lead notification ──────────────────────────────────────

async function processTikTokLead(payload, config) {
  const results = [];
  const leads = Array.isArray(payload) ? payload : [payload];

  for (const item of leads) {
    const { lead_id: leadId, ad_id: adId, campaign_id: campaignId, fields = [] } = item;
    const mapped = mapTikTokFieldsToLead(fields);

    if (!mapped.name && !mapped.email) {
      results.push({ leadId, status: 'skipped', reason: 'no_identifiable_data' });
      continue;
    }

    if (mapped.email) {
      const existing = await Lead.findOne({
        business: config.business,
        email: mapped.email,
        isDeleted: false,
      });
      if (existing) {
        results.push({ leadId, status: 'duplicate', existingId: existing._id });
        continue;
      }
    }

    const lead = await Lead.create({
      business:      config.business,
      name:          mapped.name,
      email:         mapped.email || undefined,
      phone:         mapped.phone || undefined,
      company:       mapped.company || undefined,
      source:        config.defaults?.source || 'tiktok',
      pipelineStage: config.defaults?.pipelineStage || 'new',
      temperature:   config.defaults?.temperature || 'warm',
      assignedTo:    config.defaults?.assignedTo || undefined,
      tags:          config.defaults?.tags || [],
      adSource: {
        platform:    'tiktok',
        campaignId:  campaignId,
        adId:        adId,
        leadgenId:   leadId,
        receivedAt:  new Date(),
      },
    });

    // Fail-soft de plan (auditoría de pricing del 23/ago/2026) — ver
    // comentario completo en processMetaLead().
    leadService.notifyIfOverLeadLimit(lead).catch(() => {});

    // Mismo criterio que arriba en processMetaLead() — ver comentario ahí.
    await Conversation.create({
      business:  config.business,
      lead:      lead._id,
      channel:   'manual',
      status:    'active',
      aiEnabled: true,
    });

    await WebhookConfig.updateOne(
      { _id: config._id },
      { $inc: { totalLeadsReceived: 1 }, $set: { lastReceivedAt: new Date() } }
    );

    results.push({ leadId, status: 'created', newLeadId: lead._id });
  }

  return results;
}

// ─── WhatsApp message processing ─────────────────────────────────────────────

async function processWhatsAppMessage({ phoneNumberId, from, name, text, msgId }) {
  const config = await WebhookConfig.findOne({
    'pageId': phoneNumberId,
    platform: 'meta',
    isActive: true,
  });
  if (!config) return;

  let lead = await Lead.findOne({ business: config.business, phone: from, isDeleted: false });

  if (!lead) {
    lead = await Lead.create({
      business:    config.business,
      name:        name || from,
      phone:       from,
      source:      'whatsapp',
      temperature: config.defaults?.temperature || 'warm',
      tags:        ['whatsapp'],
      whatsappId:  from,
      activity: [{ type: 'created', description: `Mensaje WhatsApp recibido: ${text.slice(0, 100)}` }],
    });

    // Fail-soft de plan (auditoría de pricing del 23/ago/2026) — ver
    // comentario completo en processMetaLead(). Solo en la rama de lead
    // NUEVO, no en cada mensaje de un lead ya existente.
    leadService.notifyIfOverLeadLimit(lead).catch(() => {});
  } else {
    lead.activity.push({ type: 'contacted', description: `WhatsApp: ${text.slice(0, 100)}` });
    lead.lastContactedAt = new Date();
    await lead.save();
  }

  return lead;
}

// ─── Gupshup (WhatsApp) ───────────────────────────────────────────────────────
// Gupshup manda dos formatos posibles según cómo esté suscrita la app:
//  - "legacy": { type: "message", app, payload: { sender: { phone, name }, payload: { text } } }
//  - "v3" (passthrough Meta): { object: "whatsapp_business_account", gs_app_id, entry: [{ id, changes: [{ field: "messages", value: { metadata, contacts, messages } }] }] }

// Tipos de media entrante soportados — mismo alcance que el envío
// SALIENTE (ai.service.js#sendMediaMessage): imagen y video. Otros tipos
// (audio, document, sticker, location, contacts, etc.) siguen sin
// reconocerse — quedan fuera de alcance de este fix, se descartan igual
// que antes.
const TIPOS_MEDIA_ENTRANTE_SOPORTADOS = ['image', 'video'];

function parseGupshupPayload(body) {
  if (body?.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
    const results = [];
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const { messages = [], contacts = [] } = change.value || {};
        for (const msg of messages) {
          const from = msg.from;
          const contact = contacts.find((c) => c.wa_id === from);
          const base = { phone: from, name: contact?.profile?.name || from, msgId: msg.id };

          if (msg.type === 'text') {
            results.push({ ...base, text: msg.text?.body || '' });
          } else if (TIPOS_MEDIA_ENTRANTE_SOPORTADOS.includes(msg.type)) {
            // Formato real confirmado en producción (payload capturado en
            // logs): msg.image/msg.video = { id, mime_type, sha256, url,
            // caption? }. `url` es TEMPORAL (Gupshup expira estos links) —
            // se re-aloja en Cloudinary en saveInboundMessage(), nunca se
            // guarda tal cual.
            const mediaField = msg[msg.type];
            if (!mediaField?.url) continue; // sin URL no hay nada que procesar
            results.push({
              ...base,
              text: mediaField.caption || '',
              mediaType: msg.type,
              mediaSourceUrl: mediaField.url,
            });
          }
          // otros tipos: se ignoran, mismo comportamiento que antes de este fix
        }
      }
    }
    return results;
  }

  if (body?.type === 'message') {
    const phone = body.payload?.sender?.phone;
    const name = body.payload?.sender?.name || phone;
    const msgId = body.payload?.id;
    const payloadType = body.payload?.type;

    if (payloadType === 'text') {
      const text = body.payload?.payload?.text;
      if (!phone || !text) return [];
      return [{ phone, text, name, msgId }];
    }

    if (TIPOS_MEDIA_ENTRANTE_SOPORTADOS.includes(payloadType)) {
      // Formato legacy documentado por Gupshup: payload.payload = { url,
      // caption?, contentType, urlExpiry } — mismo criterio, `url` temporal.
      const mediaUrl = body.payload?.payload?.url;
      if (!phone || !mediaUrl) return [];
      return [{
        phone,
        name,
        msgId,
        text: body.payload?.payload?.caption || '',
        mediaType: payloadType,
        mediaSourceUrl: mediaUrl,
      }];
    }

    return [];
  }

  return [];
}

function extractGupshupAppIdentifiers(body) {
  if (body?.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
    const entry = body.entry[0];
    return {
      format: 'v3',
      gsAppId: body.gs_app_id,
      wabaId: entry?.id,
      phoneNumberId: entry?.changes?.[0]?.value?.metadata?.phone_number_id,
    };
  }
  return { format: 'legacy', appName: body?.app };
}

async function findGupshupConfig(body) {
  const ids = extractGupshupAppIdentifiers(body);
  const candidates = [ids.appName, ids.gsAppId, ids.wabaId, ids.phoneNumberId].filter(Boolean);
  if (!candidates.length) return null;

  return WebhookConfig.findOne({
    platform: 'gupshup',
    pageId: { $in: candidates },
    isActive: true,
  });
}

// PR-10a: `channelId` es un parámetro NUEVO, opcional (`= null`) a
// propósito — el único caller real, inbound.gateway.js, ya tiene el
// WhatsAppChannel resuelto (channelResolver.resolve()) y lo pasa acá; el
// camino legacy de webhook.controller.js (parseGupshupPayload()/
// findGupshupConfig(), muerto hoy con WHATSAPP_CHANNEL_CORE_ENABLED=true
// pero todavía en el código) nunca resolvió un WhatsAppChannel real, así
// que sigue llamando a esta función sin el 3er argumento — se comporta
// exactamente igual que antes de este PR (cae al fallback de
// getChannelForConversation(), ver más abajo).
async function processGupshupMessage({ phone, text, name, mediaType, mediaSourceUrl }, businessId, channelId = null) {
  logger.info('[gupshup] processGupshupMessage: inicio', { phone, textPreview: text?.slice(0, 50), mediaType, businessId });

  // Un mensaje de imagen/video SIN caption llega con text:'' — antes este
  // guard exigía `text` siempre, así que un mensaje de media sin caption
  // (el caso más común: una foto sola, sin escribir nada) se descartaba
  // acá mismo, ni siquiera llegaba a parseGupshupPayload() a guardarse.
  if (!phone || (!text && !mediaSourceUrl)) {
    logger.warn('[gupshup] processGupshupMessage: phone vacío y sin texto ni media, se descarta', { phone, text, mediaType });
    return;
  }

  const business = await Business.findById(businessId);
  if (!business) {
    logger.warn('[gupshup] processGupshupMessage: business no encontrado', { businessId });
    return;
  }

  // Gupshup manda el teléfono "crudo" (ej. "51910265404", sin "+") — pero
  // todo Lead se guarda con `phone` normalizado a E.164 ("+51910265404")
  // por el pre('save') de lead.model.js. Sin normalizar acá también, este
  // findOne NUNCA calzaba contra un lead ya existente: caía siempre a
  // Lead.create(), que el mismo pre('save') normalizaba antes de insertar
  // — antes del índice único de Paso 3 eso creaba un lead+conversation
  // duplicado en CADA mensaje entrante de un contacto ya conocido (fuente
  // real, no hipotética, de buena parte de los duplicados que motivaron el
  // Paso 2/3); desde el índice único, en vez de duplicar, revienta con
  // E11000 y el mensaje se pierde sin respuesta de IA. Mismo criterio que
  // ya usa crearLead() (lead.service.js) desde el Paso 1.
  const phoneNormalizado = normalizeToE164(phone);
  let lead = await Lead.findOne({ business: businessId, phone: phoneNormalizado, isDeleted: false });

  // Mensaje de imagen/video sin caption -> text:'' — se usa un resumen
  // legible para la actividad del lead en vez de dejarlo vacío.
  const resumenActividad = text?.slice(0, 100) || (mediaType ? `[${mediaType}]` : '');

  if (!lead) {
    lead = await Lead.create({
      business:   businessId,
      name:       name || phoneNormalizado,
      phone:      phoneNormalizado,
      source:     'whatsapp',
      whatsappId: phoneNormalizado,
      tags:       ['whatsapp'],
      activity: [{ type: 'created', description: `Mensaje WhatsApp recibido: ${resumenActividad}` }],
    });

    // Fail-soft de plan (auditoría de pricing del 23/ago/2026) — ver
    // comentario completo en processMetaLead(). Solo en la rama de lead
    // NUEVO, no en cada mensaje de un lead ya existente.
    leadService.notifyIfOverLeadLimit(lead).catch(() => {});
  } else {
    lead.activity.push({ type: 'contacted', description: `WhatsApp: ${resumenActividad}` });
    lead.lastContactedAt = new Date();
    await lead.save();
  }
  logger.info('[gupshup] lead listo', { leadId: lead._id.toString() });

  let conversation = await Conversation.findOne({
    business: businessId,
    lead:     lead._id,
    status:   'active',
    isDeleted: false,
  });

  if (!conversation) {
    conversation = await Conversation.create({
      business:  businessId,
      lead:      lead._id,
      channel:   'whatsapp',
      // PR-10a: el WhatsAppChannel real que recibió ESTE mensaje (resuelto
      // por channelResolver.resolve() en inbound.gateway.js) — null en el
      // camino legacy, que nunca lo resuelve (ver comentario de la firma).
      whatsappChannel: channelId,
      status:    'active',
      aiEnabled: true,
    });
  }

  // Ventana de 24h de WhatsApp Business (Meta): SOLO un WhatsApp entrante
  // real la abre/renueva — este es uno de los 2 lugares que procesan uno de
  // verdad (el otro es ensureLeadAndConversation() en inbound.worker.js).
  // Se actualiza siempre, incluso si aiEnabled:false más abajo — la ventana
  // depende de que el lead escribió, no de si la IA le responde.
  conversation.lastInboundMessageAt = new Date();
  await conversation.save();

  // Guarda el mensaje entrante SIEMPRE, sin importar si la IA va a
  // responder — independiente de la decisión de abajo. Antes esto solo
  // pasaba como efecto colateral de aiService.chat() (llamado únicamente
  // cuando aiEnabled), así que un mensaje real del lead se perdía por
  // completo en cualquier conversación donde ya hubiera intervenido un
  // agente (aiEnabled:false, el estado casi permanente de una conversación
  // real) — hallazgo confirmado en producción, no hipotético. Ver
  // ai.service.js#saveInboundMessage() para el detalle completo. Si el
  // mensaje trae media (imagen/video), saveInboundMessage() la descarga
  // de la URL temporal de Gupshup y la re-aloja en Cloudinary — antes de
  // este fix, parseGupshupPayload() ni siquiera reconocía estos tipos de
  // mensaje (solo 'text'), así que la imagen/video se perdía por completo
  // y como mucho sobrevivía el caption, guardado como si fuera texto puro.
  await aiService.saveInboundMessage(
    conversation._id,
    text,
    mediaSourceUrl ? { mediaType, sourceUrl: mediaSourceUrl } : undefined
  );

  logger.info('[gupshup] conversación lista', {
    conversationId: conversation._id.toString(),
    aiEnabled: conversation.aiEnabled,
  });

  if (!conversation.aiEnabled) {
    logger.info('[gupshup] IA deshabilitada para esta conversación, no se responde', {
      conversationId: conversation._id.toString(),
    });

    // PR-C (roadmap de push/notificaciones) — disparador "lead_message": con
    // la IA apagada, generateReply() no corre (ver el `return` de abajo), así
    // que nadie le contesta al lead salvo que un humano lo vea. Se avisa por
    // los 2 canales (campanita + push) a lead.assignedTo si existe, o si no,
    // a todos los admins/dueños del negocio (leadService.resolveNotificationRecipients()
    // — ver ese archivo para el criterio completo). Antes de este fallback,
    // un lead sin assignedTo nunca notificaba a nadie, en silencio — crítico
    // para multi-tenant: un negocio nuevo no debe perder mensajes reales de
    // clientes solo porque nadie asignó el lead todavía.
    //
    // Cada destinatario y cada canal en su propio try/catch, fail-soft — un
    // fallo acá (ej. Firebase sin configurar todavía, o un destinatario con
    // datos inválidos) nunca debe hacer perder el mensaje ya guardado arriba
    // (saveInboundMessage), tumbar este webhook, ni impedir que se avise al
    // resto de los destinatarios.
    const destinatarios = await leadService.resolveNotificationRecipients(lead);
    if (destinatarios.length > 0) {
      const previewTexto = text.slice(0, 150);

      for (const userId of destinatarios) {
        try {
          await notificationService.createNotification({
            business: businessId,
            user: userId,
            type: 'info',
            category: 'lead',
            title: `Nuevo mensaje de ${lead.name}`,
            message: previewTexto,
            meta: { leadId: lead._id, conversationId: conversation._id, event: 'lead_message' },
          });
        } catch (err) {
          logger.error('[gupshup] createNotification() falló para lead_message (no afecta el mensaje ya guardado)', {
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
          logger.error('[gupshup] sendToUser() falló para lead_message (no afecta el mensaje ya guardado)', {
            leadId: lead._id.toString(),
            userId: userId.toString(),
            error: err.message,
          });
        }
      }
    }

    return { lead, conversation };
  }

  logger.info('[gupshup] llamando a aiService.generateReply', { conversationId: conversation._id.toString() });
  const { reply } = await aiService.generateReply(conversation._id, business, lead);
  logger.info('[gupshup] respuesta de IA recibida', { replyPreview: reply?.slice(0, 50) });

  // Fase 1.1 (Provider Abstraction): antes llamaba a gupshup.client.js
  // directo; ahora pasa por channelService, resuelto por el WhatsAppChannel
  // real del tenant — mismo principio que ai.service.js#sendAgentMessage()
  // (sub-fase 1.d). Modo de fallo nuevo, mismo criterio que ese cambio: si
  // el tenant no tiene un WhatsAppChannel activo, no se manda (antes se
  // intentaba igual vía el número compartido) — se loguea y no se relanza,
  // consistente con el resto de esta función (nunca lanza por datos
  // faltantes, ver los `return` de arriba).
  // PR-10a: getChannelForConversation() (no getChannelForTenant() a secas)
  // — responde por el MISMO canal que recibió el mensaje del lead cuando
  // conversation.whatsappChannel está poblado.
  const channel = await channelService.getChannelForConversation(conversation, businessId);
  if (!channel) {
    logger.warn('[gupshup] sin WhatsAppChannel activo para este tenant, no se pudo enviar la respuesta', { businessId, leadId: lead._id.toString() });
  } else {
    await channelService.sendMessage(channel._id, phone, reply);

    // PR36 del blueprint de Fase 2 — scoring automático (Buyer Profile +
    // psychologicalState, PR35) DESPUÉS de que el reply ya salió por
    // WhatsApp arriba. A propósito NO se hace `await` acá: es una promesa
    // "flotante" con su propio .catch(), así que processGupshupMessage()
    // retorna exactamente en el mismo instante que antes de este PR, sin
    // importar cuánto tarde qualifyLead() — ni el reply que el lead ya
    // recibió ni el timing de quien llama a esta función (webhook.controller.js
    // fire-and-forget, o el path síncrono de inbound.gateway.js que SÍ
    // hace await de processGupshupMessage()) se ven afectados.
    //
    // Fail-soft estricto: si qualifyLead() falla (OpenAI caído, rate
    // limit, lo que sea), el .catch() de abajo se queda con el error —
    // nunca llega a convertirse en una excepción no manejada, y nunca
    // puede tumbar esta función ni el reply que ya se envió.
    //
    // No durable a propósito (ver docs/implementation/known-issues.md
    // para el criterio general de esta sesión sobre qué SÍ necesita
    // BullMQ): si el proceso se reinicia a mitad de este scoring, la
    // promesa simplemente se pierde sin dejar rastro — no hay error que
    // loguear porque el proceso ya no existe para loguearlo. No hace
    // falta ninguna recuperación explícita: el PRÓXIMO mensaje real de
    // este lead vuelve a disparar este mismo camino, con el historial de
    // conversación ya más completo, y sobrescribe leadQualification con
    // una clasificación fresca. El único costo es que la calificación
    // queda desactualizada por un turno si el proceso murió justo acá —
    // igual de aceptable que cualquier otro dato "fire-and-forget" de
    // este sistema, y se autocorrige solo en el siguiente mensaje.
    aiService.qualifyLead(conversation._id, lead).catch((err) => {
      logger.error('[gupshup] qualifyLead() automático post-respuesta falló (no afecta el reply ya enviado)', {
        conversationId: conversation._id.toString(),
        leadId: lead._id.toString(),
        error: err.message,
      });
    });
  }
  logger.info('[gupshup] processGupshupMessage: completado', { leadId: lead._id.toString() });

  return { lead, conversation };
}

module.exports = {
  verifyMetaSignature,
  verifyTikTokSignature,
  verifyGupshupAuth,
  fetchMetaLead,
  processMetaLead,
  processTikTokLead,
  processWhatsAppMessage,
  parseGupshupPayload,
  findGupshupConfig,
  processGupshupMessage,
};
