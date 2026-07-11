const crypto = require('crypto');
const Lead = require('../leads/lead.model');
const WebhookConfig = require('./webhookConfig.model');
const Conversation = require('../ai/conversation.model');
const Business = require('../businesses/business.model');
const aiService = require('../ai/ai.service');
const {
  META_APP_SECRET,
  META_GRAPH_API_VERSION,
  TIKTOK_APP_SECRET,
  GUPSHUP_API_KEY,
  GUPSHUP_APP_NAME,
  GUPSHUP_PHONE_NUMBER,
} = require('../../config/env');

// ─── Meta signature verification ─────────────────────────────────────────────

function verifyMetaSignature(rawBody, signature) {
  if (!META_APP_SECRET) return true; // skip if not configured
  const expected = 'sha256=' + crypto
    .createHmac('sha256', META_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── TikTok signature verification ───────────────────────────────────────────

function verifyTikTokSignature(rawBody, timestamp, nonce, signature) {
  if (!TIKTOK_APP_SECRET) return true;
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
  } else {
    lead.activity.push({ type: 'contacted', description: `WhatsApp: ${text.slice(0, 100)}` });
    lead.lastContactedAt = new Date();
    await lead.save();
  }

  return lead;
}

// ─── Gupshup (WhatsApp) ───────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, message) {
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: GUPSHUP_PHONE_NUMBER,
    destination: to,
    message: JSON.stringify({ type: 'text', text: message }),
    'src.name': GUPSHUP_APP_NAME,
  });

  const response = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      apikey: GUPSHUP_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`Gupshup API error: ${response.status} ${err}`);
  }

  return response.json();
}

async function processGupshupMessage(payload, businessId) {
  const phone = payload?.payload?.sender?.phone;
  const text = payload?.payload?.payload?.text;
  if (!phone || !text) return;

  const business = await Business.findById(businessId);
  if (!business) return;

  let lead = await Lead.findOne({ business: businessId, phone, isDeleted: false });

  if (!lead) {
    lead = await Lead.create({
      business:   businessId,
      name:       payload?.payload?.sender?.name || phone,
      phone,
      source:     'whatsapp',
      whatsappId: phone,
      tags:       ['whatsapp'],
      activity: [{ type: 'created', description: `Mensaje WhatsApp recibido: ${text.slice(0, 100)}` }],
    });
  } else {
    lead.activity.push({ type: 'contacted', description: `WhatsApp: ${text.slice(0, 100)}` });
    lead.lastContactedAt = new Date();
    await lead.save();
  }

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
      status:    'active',
      aiEnabled: true,
    });
  }

  if (!conversation.aiEnabled) return { lead, conversation };

  const { reply } = await aiService.chat(conversation._id, text, business, lead);
  await sendWhatsAppMessage(phone, reply);

  return { lead, conversation };
}

module.exports = {
  verifyMetaSignature,
  verifyTikTokSignature,
  fetchMetaLead,
  processMetaLead,
  processTikTokLead,
  processWhatsAppMessage,
  sendWhatsAppMessage,
  processGupshupMessage,
};
