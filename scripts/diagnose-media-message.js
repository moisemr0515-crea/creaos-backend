/**
 * DIAGNÓSTICO DE SOLO LECTURA — no escribe nada.
 * Busca el mensaje de media más reciente en la conversación de
 * "Crea Emprendedores" e imprime su mediaUrl exacta, para verificar si es
 * una URL pública y realmente accesible.
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/env');
const Conversation = require('../src/modules/ai/conversation.model');

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Conectado a MongoDB (producción, solo lectura)\n');

  const conv = await Conversation.findById('6a54809b6a1b1ee32d9b53d0').lean();
  const conMedia = (conv.messages || []).filter((m) => m.mediaUrl);

  console.log(`Mensajes con media en esta conversación: ${conMedia.length}\n`);
  for (const m of conMedia.slice(-3)) {
    console.log(`@ ${m.timestamp?.toISOString?.() || m.timestamp}`);
    console.log(`  mediaType: ${m.mediaType}`);
    console.log(`  mediaUrl: ${m.mediaUrl}`);
    console.log(`  whatsappStatus: ${m.whatsappStatus}  whatsappError: ${m.whatsappError || '-'}`);
    console.log('');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
