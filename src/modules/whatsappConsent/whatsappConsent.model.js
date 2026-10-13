const mongoose = require('mongoose');

const CONSENT_STATUSES = ['OPTED_IN', 'OPTED_OUT', 'UNKNOWN'];
const CONSENT_PURPOSES = ['conversational', 'marketing', 'transactional', 'support'];

const consentHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: CONSENT_STATUSES, required: true },
    source: { type: String, required: true, maxlength: 80 },
    purpose: { type: String, enum: CONSENT_PURPOSES, required: true },
    occurredAt: { type: Date, required: true },
    evidenceReference: { type: String, default: null, maxlength: 300 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const whatsappConsentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    channel: { type: String, enum: ['whatsapp'], default: 'whatsapp', required: true },
    phone: { type: String, required: true, trim: true },
    status: { type: String, enum: CONSENT_STATUSES, default: 'UNKNOWN', required: true },
    source: { type: String, required: true, maxlength: 80 },
    purpose: { type: String, enum: CONSENT_PURPOSES, default: 'conversational', required: true },
    grantedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    evidenceReference: { type: String, default: null, maxlength: 300 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    history: { type: [consentHistorySchema], default: [] },
  },
  { timestamps: true }
);

// Un único estado vigente por tenant/canal/teléfono. OPTED_OUT en este
// registro ES la suppression list: no existe una segunda colección que pueda
// quedar desincronizada.
whatsappConsentSchema.index({ tenantId: 1, channel: 1, phone: 1 }, { unique: true });
whatsappConsentSchema.index({ tenantId: 1, status: 1, phone: 1 });
whatsappConsentSchema.index({ tenantId: 1, leadId: 1 });

module.exports = mongoose.model('WhatsAppConsent', whatsappConsentSchema);
module.exports.CONSENT_STATUSES = CONSENT_STATUSES;
module.exports.CONSENT_PURPOSES = CONSENT_PURPOSES;
