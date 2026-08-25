const mongoose = require('mongoose');

/**
 * WhatsAppChannel — Sección 7 del Plan Maestro (docs/architecture/plan-maestro-crea-os.md).
 * Reemplaza a WebhookConfig como identidad del negocio para Gupshup/WhatsApp
 * (ver Implementation Blueprint §4.1, §3). Modelo nuevo, sin históricos —
 * tenantId es required desde el día 1, no hace falta backfill acá (a
 * diferencia de Conversation.tenantId, ver conversation.model.js).
 *
 * v1 (sub-fase 1.a de la migración): solo el modelo. Sin controller/routes/
 * service todavía — ChannelService/ChannelResolver/TenantResolver llegan en
 * la sub-fase 1.b.
 */

const PROVIDERS = ['gupshup']; // se suma 'meta_cloud_api' u otros el día que aplique (Blueprint §4.2)
const STATUSES = ['pending', 'active', 'suspended', 'error', 'disconnected'];
const ONBOARDING_STATUSES = ['not_started', 'in_progress', 'completed', 'failed'];
const CONNECTION_TYPES = ['PLATFORM', 'DEDICATED', 'MIGRATION'];

const whatsAppChannelSchema = new mongoose.Schema(
  {
    // Tenant real (Decisión 1 del Blueprint): tenantId = businessId = Business._id,
    // validado activamente por TenantResolver (sub-fase 1.b), no solo asumido.
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    // Se mantiene businessId como campo separado (aunque hoy tenga el mismo valor
    // que tenantId) porque así lo modela el Plan Maestro §7 — ver Pregunta 1-bis
    // del Implementation Blueprint sobre una eventual jerarquía Tenant > Business.
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },

    provider: { type: String, enum: PROVIDERS, required: true, default: 'gupshup' },
    providerAccountId: { type: String, default: null }, // ID de cuenta del proveedor (ej. Gupshup App ID)
    providerAppId: { type: String, default: null },

    phoneNumber: { type: String, required: true, trim: true }, // E.164
    phoneNumberId: { type: String, required: true, trim: true }, // ID que manda el proveedor en el payload — clave real de routing
    wabaId: { type: String, default: null }, // WhatsApp Business Account ID (Meta)

    status: { type: String, enum: STATUSES, default: 'pending' },
    onboardingStatus: { type: String, enum: ONBOARDING_STATUSES, default: 'not_started' },
    connectionType: { type: String, enum: CONNECTION_TYPES, required: true },

    // Fase 2.1 (blueprint fase-2.1-blueprint-final.md §1.2/§3): pasa de String
    // libre a ObjectId ref real hacia ChannelCredentials. El discriminador de
    // "¿este canal usa env vars (PLATFORM) o ChannelCredentials (DEDICATED)?"
    // YA NO es este campo (antes: prefijo 'env:') — es connectionType, ver
    // channelCredentials.service.js#resolveCredentials(). Para canales
    // PLATFORM este campo queda simplemente null; para DEDICATED, apunta al
    // ChannelCredentials real. Migración del valor string viejo en
    // scripts/migrate-credentials-reference.js.
    credentialsReference: { type: mongoose.Schema.Types.ObjectId, ref: 'ChannelCredentials', default: null },
    webhookReference: { type: String, default: null },

    displayName: { type: String, trim: true, default: null },

    // Metadata libre para casos como el canal de plataforma (901781253) — ver
    // scripts/seed-whatsapp-channel-platform.js, que documenta acá su carácter
    // transicional (Implementation Blueprint §6, §9 sub-fase 1.a).
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Nunca 2 channels apuntando al mismo número real del mismo proveedor.
whatsAppChannelSchema.index({ provider: 1, phoneNumberId: 1 }, { unique: true });
// Queries de "canales activos de este tenant".
whatsAppChannelSchema.index({ tenantId: 1, status: 1 });

module.exports = mongoose.model('WhatsAppChannel', whatsAppChannelSchema);
module.exports.PROVIDERS = PROVIDERS;
module.exports.STATUSES = STATUSES;
module.exports.ONBOARDING_STATUSES = ONBOARDING_STATUSES;
module.exports.CONNECTION_TYPES = CONNECTION_TYPES;
