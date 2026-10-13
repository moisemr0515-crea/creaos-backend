const WhatsAppConsent = require('./whatsappConsent.model');
const Lead = require('../leads/lead.model');
const { normalizeToE164 } = require('../../utils/phone');
const { AppError } = require('../../middleware/error.middleware');

const EXPLICIT_OPT_IN_SOURCES = new Set([
  'manual_authorized',
  'web_form',
  'checkbox',
  'qr',
  'import_with_evidence',
]);

const COMMERCIAL_INTENTS = new Set(['commercial', 'marketing', 'campaign', 'automation', 'proactive_ai']);
const AUTOMATED_RESPONSE_INTENTS = new Set(['ai_automated']);

async function upsertConsent(selector, update) {
  try {
    return await WhatsAppConsent.findOneAndUpdate(selector, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  } catch (error) {
    // Dos webhooks simultáneos del mismo teléfono pueden competir por el
    // primer insert. El índice único impide duplicados; el perdedor reaplica
    // la transición sobre el registro que acaba de crear el otro proceso.
    if (error?.code !== 11000) throw error;
    return WhatsAppConsent.findOneAndUpdate(selector, update, { new: true });
  }
}

function normalizedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isOptOutMessage(value) {
  const text = normalizedText(value);
  if (!text) return false;
  if (['STOP', 'BAJA', 'SALIR', 'CANCELAR'].includes(text)) return true;
  return [
    'NO ME ESCRIBAS',
    'NO QUIERO MENSAJES',
    'NO DESEO RECIBIR MENSAJES',
  ].some((phrase) => text === phrase || text.includes(` ${phrase}`) || text.includes(`${phrase} `));
}

function publicConsent(consent, fallback = {}) {
  if (!consent) {
    return {
      status: 'UNKNOWN',
      source: null,
      purpose: null,
      grantedAt: null,
      revokedAt: null,
      ...fallback,
    };
  }
  return {
    status: consent.status,
    source: consent.source,
    purpose: consent.purpose,
    grantedAt: consent.grantedAt,
    revokedAt: consent.revokedAt,
  };
}

async function recordInboundConsent({ tenantId, leadId, phone, text, providerMessageId }) {
  const normalizedPhone = normalizeToE164(phone);
  if (!tenantId || !normalizedPhone) throw new AppError('Contexto de consentimiento WhatsApp inválido', 400);

  const now = new Date();
  const evidenceReference = providerMessageId ? `provider-message:${providerMessageId}` : null;
  const existing = await WhatsAppConsent.findOne({ tenantId, channel: 'whatsapp', phone: normalizedPhone });

  if (isOptOutMessage(text)) {
    const transition = {
      status: 'OPTED_OUT',
      source: 'user_message',
      purpose: existing?.purpose || 'conversational',
      occurredAt: now,
      evidenceReference,
    };
    const consent = await upsertConsent(
      { tenantId, channel: 'whatsapp', phone: normalizedPhone },
      {
        $set: {
          leadId,
          status: 'OPTED_OUT',
          source: 'user_message',
          purpose: existing?.purpose || 'conversational',
          revokedAt: now,
          evidenceReference,
        },
        $push: { history: transition },
        $setOnInsert: { grantedAt: null },
      }
    );
    return { consent, status: consent.status, optedOut: true, suppressed: true };
  }

  // Un inbound voluntario acredita consentimiento conversacional, pero jamás
  // reactiva automáticamente una baja previa ni habilita marketing.
  if (existing?.status === 'OPTED_OUT') {
    return { consent: existing, status: existing.status, optedOut: false, suppressed: true };
  }
  if (existing?.status === 'OPTED_IN') {
    if (!existing.leadId && leadId) {
      existing.leadId = leadId;
      await existing.save();
    }
    return { consent: existing, status: existing.status, optedOut: false, suppressed: false };
  }

  const transition = {
    status: 'OPTED_IN',
    source: 'user_initiated_message',
    purpose: 'conversational',
    occurredAt: now,
    evidenceReference,
  };
  const consent = await upsertConsent(
    { tenantId, channel: 'whatsapp', phone: normalizedPhone },
    {
      $set: {
        leadId,
        status: 'OPTED_IN',
        source: 'user_initiated_message',
        purpose: 'conversational',
        grantedAt: now,
        revokedAt: null,
        evidenceReference,
      },
      $push: { history: transition },
    }
  );
  return { consent, status: consent.status, optedOut: false, suppressed: false };
}

async function resolveLeadForTenant(tenantId, leadId) {
  const lead = await Lead.findOne({ _id: leadId, business: tenantId, isDeleted: false }).select('_id business phone');
  if (!lead) throw new AppError('Lead no encontrado', 404);
  if (!lead.phone) throw new AppError('El lead no tiene teléfono', 422);
  return lead;
}

async function getConsentForLead(tenantId, leadId) {
  const lead = await resolveLeadForTenant(tenantId, leadId);
  const phone = normalizeToE164(lead.phone);
  const consent = await WhatsAppConsent.findOne({ tenantId, channel: 'whatsapp', phone });
  return publicConsent(consent);
}

async function registerExplicitOptIn({ tenantId, leadId, source, purpose = 'marketing', evidenceReference, recordedBy, confirmation }) {
  if (confirmation !== true) throw new AppError('Debes confirmar que existe evidencia válida de consentimiento', 422);
  if (!EXPLICIT_OPT_IN_SOURCES.has(source)) throw new AppError('Fuente de consentimiento no autorizada', 422);
  if (!String(evidenceReference || '').trim()) throw new AppError('La referencia de evidencia es obligatoria', 422);
  if (!['marketing', 'transactional', 'support'].includes(purpose)) throw new AppError('Propósito de consentimiento inválido', 422);

  const lead = await resolveLeadForTenant(tenantId, leadId);
  const phone = normalizeToE164(lead.phone);
  const now = new Date();
  const transition = {
    status: 'OPTED_IN',
    source,
    purpose,
    occurredAt: now,
    evidenceReference: String(evidenceReference).trim(),
    recordedBy,
  };
  const consent = await upsertConsent(
    { tenantId, channel: 'whatsapp', phone },
    {
      $set: {
        leadId: lead._id,
        status: 'OPTED_IN',
        source,
        purpose,
        grantedAt: now,
        revokedAt: null,
        evidenceReference: String(evidenceReference).trim(),
        recordedBy,
      },
      $push: { history: transition },
    }
  );
  return publicConsent(consent);
}

async function canSendWhatsAppMessage({ tenantId, phone, leadId, messageIntent = 'reactive' }) {
  const isCommercial = COMMERCIAL_INTENTS.has(messageIntent);
  const isAutomatedResponse = AUTOMATED_RESPONSE_INTENTS.has(messageIntent);
  // Una respuesta humana reactiva/soporte conserva la excepción operativa.
  // La IA automática debe consultar suppression aunque responda a un inbound.
  if (!isCommercial && !isAutomatedResponse) return { allowed: true, reason: null };
  let normalizedPhone = normalizeToE164(phone);
  if (!normalizedPhone && leadId) {
    const lead = await resolveLeadForTenant(tenantId, leadId);
    normalizedPhone = normalizeToE164(lead.phone);
  }
  if (!normalizedPhone) return { allowed: false, reason: 'whatsapp_consent_required' };

  const consent = await WhatsAppConsent.findOne({ tenantId, channel: 'whatsapp', phone: normalizedPhone });
  if (consent?.status === 'OPTED_OUT') return { allowed: false, reason: 'whatsapp_suppressed' };
  if (isAutomatedResponse) return { allowed: true, reason: null };
  if (consent?.status !== 'OPTED_IN' || consent.purpose !== 'marketing') {
    return { allowed: false, reason: 'whatsapp_consent_required' };
  }
  return { allowed: true, reason: null };
}

async function assertCanSendWhatsAppMessage(context) {
  const result = await canSendWhatsAppMessage(context);
  if (!result.allowed) {
    const message = result.reason === 'whatsapp_suppressed'
      ? 'El destinatario solicitó la baja de mensajes comerciales por WhatsApp'
      : 'No existe consentimiento válido para este envío comercial por WhatsApp';
    throw new AppError(message, 422, result.reason);
  }
  return result;
}

module.exports = {
  isOptOutMessage,
  recordInboundConsent,
  getConsentForLead,
  registerExplicitOptIn,
  canSendWhatsAppMessage,
  assertCanSendWhatsAppMessage,
  EXPLICIT_OPT_IN_SOURCES,
};
