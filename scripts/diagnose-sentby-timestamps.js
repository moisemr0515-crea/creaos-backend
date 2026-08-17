/**
 * DIAGNÓSTICO DE SOLO LECTURA — no escribe nada.
 * Lista, ordenados por fecha, los últimos mensajes assistant/ai y
 * assistant/agent de cada conversación — para ver si las respuestas
 * REALES de IA (sentBy:'ai') siguen generándose recientemente o si se
 * detuvieron en algún punto.
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const Conversation = require('../src/modules/ai/conversation.model');
const Lead = require('../src/modules/leads/lead.model');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Conectado a MongoDB (producción, solo lectura)\n');

  const convs = await Conversation.find({ isDeleted: false, channel: 'whatsapp' }).lean();

  const todosAssistant = [];
  for (const c of convs) {
    const lead = await Lead.findById(c.lead).select('name').lean();
    for (const m of c.messages || []) {
      if (m.role === 'assistant') {
        todosAssistant.push({
          leadName: lead?.name,
          conversationId: c._id.toString(),
          sentBy: m.sentBy,
          timestamp: m.timestamp,
          content: (m.content || '').slice(0, 50),
        });
      }
    }
  }

  todosAssistant.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  console.log('=== TODOS los mensajes assistant/ai (respuestas reales de IA), ordenados por fecha ===');
  const soloIA = todosAssistant.filter((m) => m.sentBy === 'ai');
  for (const m of soloIA) {
    console.log(`${m.timestamp?.toISOString?.() || m.timestamp} — "${m.leadName}" — "${m.content}"`);
  }
  console.log(`\nTotal: ${soloIA.length}. Más reciente: ${soloIA[soloIA.length - 1]?.timestamp || 'N/A'}`);

  console.log('\n\n=== TODOS los mensajes assistant/agent (agente humano), últimos 10 ===');
  const soloAgente = todosAssistant.filter((m) => m.sentBy === 'agent');
  for (const m of soloAgente.slice(-10)) {
    console.log(`${m.timestamp?.toISOString?.() || m.timestamp} — "${m.leadName}" — "${m.content}"`);
  }
  console.log(`\nTotal: ${soloAgente.length}. Más reciente: ${soloAgente[soloAgente.length - 1]?.timestamp || 'N/A'}`);

  console.log('\n\n=== Últimos 10 mensajes assistant/undefined (legacy, sin sentBy) ===');
  const soloUndefined = todosAssistant.filter((m) => m.sentBy === undefined);
  for (const m of soloUndefined.slice(-10)) {
    console.log(`${m.timestamp?.toISOString?.() || m.timestamp} — "${m.leadName}" — "${m.content}"`);
  }
  console.log(`\nTotal: ${soloUndefined.length}. Más reciente: ${soloUndefined[soloUndefined.length - 1]?.timestamp || 'N/A'}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
