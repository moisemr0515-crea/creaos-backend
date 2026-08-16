/**
 * DIAGNÓSTICO DE SOLO LECTURA — no escribe nada.
 *
 * Investiga si los mensajes de WhatsApp ENTRANTES (del lead) se están
 * guardando correctamente. Reportado por Lovable: el frontend espera
 * mensajes con `direction:"in"`, sospechan que el backend no los devuelve
 * (o no los guarda) para ciertos leads.
 *
 * Para cada lead nombrado, imprime TODOS sus mensajes (role, sentBy,
 * mediaType, timestamp, primeros 60 chars de content) de todas sus
 * Conversations (activas y no), + lastInboundMessageAt.
 *
 * Uso:
 *   railway run node scripts/diagnose-inbound-messages.js
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const Lead = require('../src/modules/leads/lead.model');
const Conversation = require('../src/modules/ai/conversation.model');

const NOMBRES = ['Crea Emprendedores', 'Moises Ramos', 'Te Quiero Moringa', 'Lunde Calisaya', 'Myrel'];

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Conectado a MongoDB (producción, solo lectura)\n');

  for (const nombre of NOMBRES) {
    console.log(`\n================= ${nombre} =================`);
    const leads = await Lead.find({ name: new RegExp(nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
      .select('_id name phone isDeleted business')
      .lean();

    if (leads.length === 0) {
      console.log('  (ningún Lead encontrado con ese nombre)');
      continue;
    }

    for (const lead of leads) {
      console.log(`\n  Lead ${lead._id} — "${lead.name}" (${lead.phone}) isDeleted:${lead.isDeleted}`);

      const convs = await Conversation.find({ lead: lead._id }).lean();
      if (convs.length === 0) {
        console.log('    (sin conversaciones)');
        continue;
      }

      for (const c of convs) {
        const inbound = (c.messages || []).filter((m) => m.role === 'user');
        console.log(`\n    Conversation ${c._id} — channel:${c.channel} status:${c.status} isDeleted:${c.isDeleted}`);
        console.log(`      lastInboundMessageAt: ${c.lastInboundMessageAt || 'null'}`);
        console.log(`      total mensajes: ${c.messages?.length || 0}  |  role:'user' (entrantes en nuestro schema): ${inbound.length}`);

        if (inbound.length > 0) {
          console.log('      últimos 5 entrantes (role:user):');
          for (const m of inbound.slice(-5)) {
            console.log(`        @ ${m.timestamp?.toISOString?.() || m.timestamp} — "${(m.content || '').slice(0, 60)}"`);
          }
        }

        // Muestra los últimos 5 mensajes de CUALQUIER tipo, tal cual quedan
        // guardados (role/sentBy), para ver el shape real sin asumir nada.
        const ultimos = (c.messages || []).slice(-5);
        if (ultimos.length) {
          console.log('      últimos 5 mensajes (cualquier role), shape real:');
          for (const m of ultimos) {
            console.log(`        role:${m.role} sentBy:${m.sentBy} whatsappStatus:${m.whatsappStatus} mediaType:${m.mediaType || '-'} @ ${m.timestamp?.toISOString?.() || m.timestamp} "${(m.content || '').slice(0, 50)}"`);
          }
        }
      }
    }
  }

  console.log('\n\n================= Chequeo global: lastInboundMessageAt en TODAS las conversaciones activas =================');
  const todasActivas = await Conversation.find({ isDeleted: false }).select('_id lead business channel lastInboundMessageAt messages').lean();
  for (const c of todasActivas) {
    const lead = await Lead.findById(c.lead).select('name').lean();
    const inboundCount = (c.messages || []).filter((m) => m.role === 'user').length;
    console.log(`  Conversation ${c._id} (lead: "${lead?.name}") channel:${c.channel} lastInboundMessageAt:${c.lastInboundMessageAt || 'null'} mensajes-entrantes:${inboundCount} total-mensajes:${c.messages?.length || 0}`);
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('❌ Error en diagnóstico:', err);
  process.exit(1);
});
