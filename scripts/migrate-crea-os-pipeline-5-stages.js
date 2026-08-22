/**
 * Migración puntual, YA EJECUTADA (ver commit) — negocio CREA OS
 * (6a3a028d8f0b137e53a05b82) hacia el nuevo default de 5 etapas
 * (pipeline.model.js#DEFAULT_STAGES): new, contacted, negotiating, won, lost.
 *
 * Contexto: DEFAULT_STAGES se redujo de 7 a 5 keys — este script actualiza
 * el ÚNICO Pipeline real que existía con la plantilla vieja de 7 etapas
 * ("Pipeline Principal", negocio CREA OS). No reasigna Pipeline.stages a
 * ningún otro negocio — Myrel Company (6a52de897e51be411da70623) no tiene
 * ningún Pipeline creado todavía y se deja fuera de esta migración a
 * propósito (discrepancia sobre si CREA OS/Myrel Company debían haberse
 * fusionado, sin resolver todavía).
 *
 * Diagnóstico previo (solo lectura, confirmado antes de escribir nada):
 * los 10 leads activos de CREA OS están TODOS en pipelineStage:'new'. Cero
 * leads en 'interested'/'proposal' (las 2 etapas que más preocupaba migrar)
 * ni en ninguna otra etapa — confirmado también a nivel GLOBAL (los 13
 * leads activos de todo el sistema están en 'new'). Como 'new' existe
 * igual en la plantilla nueva, este script NO necesita remapear ningún
 * lead — solo reemplaza pipeline.stages por el DEFAULT_STAGES nuevo, y
 * verifica al final que ningún lead haya quedado con un pipelineStage
 * fuera de las 5 keys nuevas (paso 4 pedido).
 *
 * Uso: node scripts/migrate-crea-os-pipeline-5-stages.js
 * Requiere MONGODB_URI_PROD en .env — corre contra producción a propósito,
 * es una migración real de un solo Pipeline documento, no un backfill masivo.
 */
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']); // mismo override que plans.seed.js — el DNS local falla contra el SRV de Atlas

require('dotenv').config();
const mongoose = require('mongoose');

const BUSINESS_ID = '6a3a028d8f0b137e53a05b82'; // CREA OS, confirmado
const EXPECTED_BUSINESS_NAME = 'CREA OS';

(async () => {
  const uri = process.env.MONGODB_URI_PROD;
  if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');
  await mongoose.connect(uri);

  const Business = require('../src/modules/businesses/business.model');
  const Lead = require('../src/modules/leads/lead.model');
  const Pipeline = require('../src/modules/pipeline/pipeline.model');

  const business = await Business.findById(BUSINESS_ID);
  if (!business) throw new Error(`Negocio ${BUSINESS_ID} no encontrado — abortando, no se tocó nada`);
  if (business.name !== EXPECTED_BUSINESS_NAME) {
    throw new Error(`Negocio ${BUSINESS_ID} tiene name:"${business.name}", esperaba "${EXPECTED_BUSINESS_NAME}" — abortando, no se tocó nada`);
  }
  console.log(`✅ Negocio confirmado: "${business.name}" (${business._id})`);

  const pipeline = await Pipeline.findOne({ business: business._id, isDefault: true, isActive: true });
  if (!pipeline) throw new Error('Pipeline default no encontrado para CREA OS — abortando, no se tocó nada');

  const stagesAntes = pipeline.stages.map((s) => s.key);
  console.log(`Pipeline "${pipeline.name}" (${pipeline._id}) — stages ANTES: ${stagesAntes.join(', ')}`);

  pipeline.stages = Pipeline.DEFAULT_STAGES;
  await pipeline.save();

  const pipelineRefrescado = await Pipeline.findById(pipeline._id);
  const stagesDespues = pipelineRefrescado.stages.map((s) => s.key);
  console.log(`Pipeline "${pipeline.name}" (${pipeline._id}) — stages DESPUÉS: ${stagesDespues.join(', ')}`);

  // Verificación pedida (paso 4): ningún lead debe quedar con un
  // pipelineStage que ya no exista en el Pipeline actualizado.
  const leads = await Lead.find({ business: business._id, isDeleted: false }).select('_id name pipelineStage');
  const stagesValidas = new Set(stagesDespues);
  const leadsHuerfanos = leads.filter((l) => !stagesValidas.has(l.pipelineStage));

  console.log(`\nLeads activos verificados: ${leads.length}`);
  if (leadsHuerfanos.length > 0) {
    console.error(`⚠️  ${leadsHuerfanos.length} lead(s) quedaron con un pipelineStage huérfano (fuera de las 5 etapas nuevas):`);
    for (const l of leadsHuerfanos) console.error(`   - ${l._id} "${l.name}": pipelineStage:"${l.pipelineStage}"`);
    process.exitCode = 1;
  } else {
    console.log('✅ Ningún lead quedó con un pipelineStage fuera de las 5 etapas nuevas.');
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error('ERROR — migración abortada:', err.message);
  process.exit(1);
});
