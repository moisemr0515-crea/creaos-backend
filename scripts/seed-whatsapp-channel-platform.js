/**
 * Crea el WhatsAppChannel de plataforma (901781253, connectionType:'PLATFORM')
 * para CREA OS, replicando los datos del WebhookConfig gupshup actual — sin
 * modificar ni borrar ese WebhookConfig (sigue disponible como mecanismo de
 * rollback, Blueprint §5 paso 6/9).
 *
 * Documenta acá (metadata.note) el carácter transicional de este canal, tal
 * como pedía la sub-fase 0.a (ver docs/implementation/fase-0a-contencion-report.md §5).
 *
 * Idempotente: si ya existe un WhatsAppChannel con {provider, phoneNumberId},
 * no crea uno nuevo — lo reporta y termina.
 *
 * Uso:
 *   node scripts/seed-whatsapp-channel-platform.js --dry-run   (no escribe nada, solo imprime el doc)
 *   node scripts/seed-whatsapp-channel-platform.js             (escribe, contra Mongo local)
 *   railway run node scripts/seed-whatsapp-channel-platform.js --dry-run   (preview contra producción)
 *   railway run node scripts/seed-whatsapp-channel-platform.js            (real, contra producción —
 *     SOLO tras revisar el --dry-run y con aprobación explícita, ver PR de la sub-fase 1.a)
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const { normalizeToE164 } = require('../src/utils/phone');

const WebhookConfig = require('../src/modules/webhooks/webhookConfig.model');
const Business = require('../src/modules/businesses/business.model');
const WhatsAppChannel = require('../src/modules/channels/whatsappChannel.model');

const BUSINESS_ID = '6a3a028d8f0b137e53a05b82'; // CREA OS — mismo ID que scripts/seed-gupshup-webhook.js

const isDryRun = process.argv.includes('--dry-run');

const run = async () => {
  await mongoose.connect(env.MONGODB_URI);
  logger.info(`✅ MongoDB conectado${isDryRun ? ' (--dry-run, no se escribirá nada)' : ''}`);
  logger.info(`   DB: ${mongoose.connection.name}`);

  const business = await Business.findById(BUSINESS_ID, 'name');
  if (!business) {
    logger.error(`❌ No se encontró el negocio CREA OS (${BUSINESS_ID})`);
    process.exit(1);
  }

  const webhookConfig = await WebhookConfig.findOne({ platform: 'gupshup', business: BUSINESS_ID });
  if (!webhookConfig) {
    logger.error('❌ No se encontró WebhookConfig gupshup para CREA OS — nada que migrar');
    process.exit(1);
  }

  // pageId es el identificador que Gupshup manda hoy en el payload real
  // (gs_app_id / wabaId / phone_number_id según el formato — ver
  // webhook.service.js#findGupshupConfig()) y contra el que ya matchea
  // exitosamente hoy. Se reutiliza tal cual como phoneNumberId del canal
  // nuevo para no romper el routing real que ya funciona (Caso 6 confirmado).
  const phoneNumberId = webhookConfig.pageId;
  const phoneNumber = normalizeToE164(env.GUPSHUP_PHONE_NUMBER) || null;

  const existing = await WhatsAppChannel.findOne({ provider: 'gupshup', phoneNumberId });
  if (existing) {
    logger.info(`ℹ️  Ya existe un WhatsAppChannel para phoneNumberId="${phoneNumberId}" (id: ${existing._id}) — nada que hacer.`);
    await mongoose.disconnect();
    return;
  }

  const channelDoc = {
    tenantId: BUSINESS_ID,
    businessId: BUSINESS_ID,
    provider: 'gupshup',
    providerAccountId: env.GUPSHUP_APP_NAME || null,
    providerAppId: null,
    phoneNumber,
    phoneNumberId,
    wabaId: env.GUPSHUP_WABA_ID || null,
    status: 'active', // ya está operativo hoy (Caso 6 confirmado en producción)
    onboardingStatus: 'completed',
    connectionType: 'PLATFORM',
    // Fase 2.1: credentialsReference pasó de String libre a ObjectId ref
    // hacia ChannelCredentials (whatsappChannel.model.js) — un string ya no
    // es un valor válido acá. El canal PLATFORM no necesita este campo: el
    // discriminador que decide "leer de env vars vs. de ChannelCredentials"
    // es connectionType, no credentialsReference (ver
    // channelCredentials.service.js#resolveCredentials()). Las credenciales
    // reales siguen viviendo en variables de entorno (GUPSHUP_API_KEY, etc.).
    credentialsReference: null,
    webhookReference: `webhookconfig:${webhookConfig._id}`,
    displayName: `${business.name} — Canal de plataforma (compartido/QA)`,
    metadata: {
      transitional: true,
      note:
        'Canal transicional heredado de WebhookConfig (arquitectura pre-migración). ' +
        'No es un canal "normal" más — ver Implementation Blueprint §6 (Distinción ' +
        'Plataforma vs Cliente Real). A partir de Fase 1, ningún tenant nuevo puede ' +
        'tener un WhatsAppChannel con connectionType:PLATFORM salvo CREA OS.',
      legacyWebhookConfigId: String(webhookConfig._id),
      migratedAt: new Date().toISOString(),
    },
  };

  if (isDryRun) {
    logger.info('── DRY RUN — esto es lo que se crearía (nada se escribió) ──');
    logger.info(JSON.stringify(channelDoc, null, 2));
    await mongoose.disconnect();
    return;
  }

  const created = await WhatsAppChannel.create(channelDoc);
  logger.info(`✓ WhatsAppChannel creado: ${created._id} (phoneNumberId=${created.phoneNumberId}, tenantId=${created.tenantId})`);

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error creando WhatsAppChannel de plataforma:', err.message);
  process.exit(1);
});
