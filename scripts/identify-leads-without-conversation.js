/**
 * DIAGNÓSTICO DE SOLO LECTURA — no escribe nada.
 *
 * Identifica leads activos (isDeleted:false) que NO tienen ninguna
 * Conversation activa asociada — el gap que fix/lead-conversation-on-creation
 * cierra para leads NUEVOS (creados desde ese deploy en adelante), pero que
 * deja sin cubrir para leads YA existentes creados antes por cualquiera de
 * los 3 orígenes que no la creaban (manual, importado, publicidad).
 *
 * Agrupa el resultado por `source` para dimensionar el impacto por origen,
 * y muestra una muestra de ejemplos por grupo.
 *
 * Uso:
 *   railway run node scripts/identify-leads-without-conversation.js
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
  logger.info('✅ MongoDB conectado (solo lectura)');

  const leadsActivos = await Lead.find({ isDeleted: false }).select('_id name source business createdAt').lean();
  logger.info(`Total de leads activos en la base: ${leadsActivos.length}`);

  const leadIds = leadsActivos.map((l) => l._id);
  const conversacionesActivas = await Conversation.find({ lead: { $in: leadIds }, isDeleted: false })
    .select('lead')
    .lean();
  const leadsConConversacion = new Set(conversacionesActivas.map((c) => c.lead.toString()));

  const sinConversacion = leadsActivos.filter((l) => !leadsConConversacion.has(l._id.toString()));

  logger.info(`\nLeads activos SIN ninguna Conversation activa: ${sinConversacion.length} / ${leadsActivos.length}`);

  const porOrigen = {};
  for (const l of sinConversacion) {
    porOrigen[l.source] = porOrigen[l.source] || [];
    porOrigen[l.source].push(l);
  }

  for (const [source, leads] of Object.entries(porOrigen)) {
    console.log(`\n=== source: "${source}" — ${leads.length} leads sin Conversation ===`);
    const muestra = leads.slice(0, 5);
    for (const l of muestra) {
      console.log(`  ${l._id}  "${l.name}"  business:${l.business}  createdAt:${l.createdAt.toISOString()}`);
    }
    if (leads.length > muestra.length) {
      console.log(`  ... y ${leads.length - muestra.length} más`);
    }
  }

  console.log(`\n\nTOTAL a backfillear: ${sinConversacion.length}`);
  console.log(JSON.stringify(sinConversacion.map((l) => l._id.toString())).length > 0
    ? `\n(IDs completos disponibles en el output de arriba por grupo; el script de backfill los vuelve a calcular con el mismo criterio al ejecutarse)`
    : '');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error('❌ Error en diagnóstico:', err);
  process.exit(1);
});
