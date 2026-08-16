/**
 * BACKFILL — crea una Conversation para todo lead ACTIVO (isDeleted:false)
 * que no tenga ninguna. Cierra, para los leads YA existentes, el mismo gap
 * que fix/lead-conversation-on-creation cierra para leads nuevos a partir de
 * ese deploy (manual, importado, publicidad — WhatsApp entrante ya creaba
 * la suya).
 *
 * Mismo shape que usan crearLead()/procesarImportacion()/processMetaLead()/
 * processTikTokLead() tras ese fix: channel:'manual', status:'active',
 * aiEnabled:true. Solo CREA — no toca ni borra nada existente.
 *
 * Idempotente: vuelve a calcular "leads sin Conversation activa" en cada
 * corrida (mismo criterio que scripts/identify-leads-without-conversation.js)
 * — si se corre dos veces, la segunda vez no encuentra nada que crear.
 *
 * Uso:
 *   node scripts/backfill-lead-conversations.js          # local
 *   railway run node scripts/backfill-lead-conversations.js   # producción
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const logger = require('../src/utils/logger');
const Lead = require('../src/modules/leads/lead.model');
const Conversation = require('../src/modules/ai/conversation.model');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  logger.info('✅ MongoDB conectado');

  const leadsActivos = await Lead.find({ isDeleted: false }).select('_id business source name').lean();
  const leadIds = leadsActivos.map((l) => l._id);

  const conversacionesActivas = await Conversation.find({ lead: { $in: leadIds }, isDeleted: false })
    .select('lead')
    .lean();
  const leadsConConversacion = new Set(conversacionesActivas.map((c) => c.lead.toString()));

  const sinConversacion = leadsActivos.filter((l) => !leadsConConversacion.has(l._id.toString()));

  if (sinConversacion.length === 0) {
    logger.info('ℹ️  Ningún lead activo sin Conversation — nada que hacer.');
    await mongoose.disconnect();
    return;
  }

  logger.info(`Creando Conversation para ${sinConversacion.length} lead(s)...`);

  const docs = sinConversacion.map((l) => ({
    business:  l.business,
    lead:      l._id,
    channel:   'manual',
    status:    'active',
    aiEnabled: true,
  }));

  const inserted = await Conversation.insertMany(docs, { ordered: false });

  logger.info(`✓ ${inserted.length} Conversation(es) creada(s):`);
  for (const l of sinConversacion) {
    console.log(`  lead ${l._id} "${l.name}" (source: ${l.source}) → nueva Conversation`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error en el backfill:', err);
  process.exit(1);
});
