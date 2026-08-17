/**
 * DIAGNÓSTICO DE SOLO LECTURA — no escribe nada.
 * Cuenta mensajes por (role, sentBy) en TODAS las conversaciones activas,
 * para confirmar si existen respuestas de IA reales guardadas
 * (role:assistant + sentBy:'ai') vs. mensajes de agente
 * (role:assistant + sentBy:'agent'), y revisa el estado actual de
 * aiEnabled en cada conversación.
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

  const conteo = {};
  let totalMensajes = 0;

  for (const c of convs) {
    const lead = await Lead.findById(c.lead).select('name').lean();
    const porTipo = {};
    for (const m of c.messages || []) {
      const clave = `${m.role}/${m.sentBy}`;
      porTipo[clave] = (porTipo[clave] || 0) + 1;
      conteo[clave] = (conteo[clave] || 0) + 1;
      totalMensajes++;
    }
    console.log(`Conversation ${c._id} (lead: "${lead?.name}") aiEnabled:${c.aiEnabled} lastInboundMessageAt:${c.lastInboundMessageAt || 'null'}`);
    console.log(`  ${JSON.stringify(porTipo)}`);
  }

  console.log('\n\n================= Totales globales (role/sentBy) =================');
  console.log(JSON.stringify(conteo, null, 2));
  console.log(`\nTotal de mensajes revisados: ${totalMensajes}`);
  console.log(`\n¿Existe algún mensaje role:assistant + sentBy:ai (respuesta REAL de IA)? ${conteo['assistant/ai'] ? `SÍ, ${conteo['assistant/ai']}` : 'NO, ninguno'}`);
  console.log(`¿Existe algún mensaje role:assistant + sentBy:agent (agente humano)? ${conteo['assistant/agent'] ? `SÍ, ${conteo['assistant/agent']}` : 'NO, ninguno'}`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
