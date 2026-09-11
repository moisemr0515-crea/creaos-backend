/**
 * Backfill retroactivo — parte 2 de 3 del blueprint del incidente de
 * producción del 11/sep/2026 (docs/implementation/known-issues.md): leads
 * creados por caminos automáticos (WhatsApp entrante, ads, automatizaciones)
 * nunca seteaban `pipeline` — invisibles en Pipeline (GET /pipeline/:id/board,
 * $match por pipeline._id). La parte 1 (mitigación, ya en producción) trata
 * un lead sin `pipeline` como perteneciente al pipeline pedido, así que la
 * visibilidad YA está restaurada — este script no es urgente para eso, es
 * para dejar el dato real: cada lead con su `pipeline` real seteado, en vez
 * de depender de esa red de seguridad indefinidamente.
 *
 * Alcance: por cada negocio, si tiene EXACTAMENTE 1 pipeline activo, le
 * asigna ese pipeline a todos sus leads sin el campo `pipeline` seteado. Si
 * tiene 0 o 2+ pipelines activos, se SALTEA y se loguea — no se asume cuál
 * es "el" default (hoy, con los datos reales de producción, ningún negocio
 * tiene 2+, pero el script no debe adivinar si eso cambia). No crea ningún
 * Pipeline nuevo — a diferencia de obtenerOCrearDefault(), que si no
 * encuentra uno, LO CREA; acá, un negocio sin pipeline simplemente no tiene
 * nada que backfillear (tampoco tiene leads visibles en Pipeline hoy, así
 * que no hay urgencia).
 *
 * Idempotente por la propia query: `pipeline:{$exists:false}` es justo lo
 * que deja de ser cierto después de backfillear, así que correrlo una
 * segunda vez no encuentra nada.
 *
 * Uso: node scripts/backfill-leads-pipeline.js
 * Requiere MONGODB_URI_PROD en .env — mismo patrón que
 * migrate-automation-seeds-real-triggers.js.
 */
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']); // mismo override que el resto de scripts de este repo — el DNS local falla contra el SRV de Atlas

require('dotenv').config();
const mongoose = require('mongoose');

/**
 * Corre el backfill completo contra la conexión Mongo ya activa (el caller
 * es responsable de conectar/desconectar — así el .test.js puede apuntar a
 * una base de test sin tocar nada de esto).
 * @returns {Promise<{negociosConHuerfanos:number, negociosBackfilleados:number, negociosSalteados:number, totalBackfilleados:number, salteados:Array}>}
 */
async function backfillLeadsPipeline() {
  const Business = require('../src/modules/businesses/business.model');
  const Pipeline = require('../src/modules/pipeline/pipeline.model');
  const Lead = require('../src/modules/leads/lead.model');

  const negocios = await Business.find({}).select('_id name').lean();

  let negociosConHuerfanos = 0;
  let negociosBackfilleados = 0;
  let negociosSalteados = 0;
  let totalBackfilleados = 0;
  const salteados = [];

  for (const business of negocios) {
    // eslint-disable-next-line no-await-in-loop -- script de un solo uso, volumen bajo (7 negocios reales hoy), secuencial a propósito
    const huerfanos = await Lead.countDocuments({ business: business._id, pipeline: { $exists: false } });
    if (huerfanos === 0) continue;

    negociosConHuerfanos++;

    // eslint-disable-next-line no-await-in-loop
    const pipelinesActivos = await Pipeline.find({ business: business._id, isActive: true }).select('_id').lean();

    if (pipelinesActivos.length !== 1) {
      negociosSalteados++;
      salteados.push({ business: business.name, businessId: business._id.toString(), huerfanos, pipelinesActivos: pipelinesActivos.length });
      console.warn(
        `  ⚠️  ${business.name} (${business._id}) tiene ${pipelinesActivos.length} pipeline(s) activo(s) (se necesita exactamente 1) — ` +
        `se saltea, quedan ${huerfanos} lead(s) sin backfillear.`
      );
      continue;
    }

    const pipeline = pipelinesActivos[0];
    // eslint-disable-next-line no-await-in-loop
    const resultado = await Lead.updateMany(
      { business: business._id, pipeline: { $exists: false } },
      { $set: { pipeline: pipeline._id } }
    );

    negociosBackfilleados++;
    totalBackfilleados += resultado.modifiedCount;
    console.log(`  ✅ ${business.name} (${business._id}): ${resultado.modifiedCount} lead(s) backfilleado(s) al pipeline ${pipeline._id}`);
  }

  return { negociosConHuerfanos, negociosBackfilleados, negociosSalteados, totalBackfilleados, salteados };
}

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI_PROD;
    if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');
    await mongoose.connect(uri);

    console.log('Backfilleando leads sin `pipeline` seteado...\n');
    const resumen = await backfillLeadsPipeline();

    console.log('');
    if (resumen.negociosConHuerfanos === 0) {
      console.log('Nada para backfillear — ningún negocio tiene leads sin `pipeline`.');
    } else {
      console.log(
        `Resumen: ${resumen.negociosBackfilleados} negocio(s) backfilleado(s) (${resumen.totalBackfilleados} lead(s) en total), ` +
        `${resumen.negociosSalteados} negocio(s) salteado(s) de ${resumen.negociosConHuerfanos} con leads huérfanos.`
      );
      if (resumen.negociosSalteados > 0) {
        console.warn('⚠️  Negocios salteados (revisar manualmente):', JSON.stringify(resumen.salteados, null, 2));
      }
    }

    await mongoose.disconnect();
  })().catch((err) => {
    console.error('ERROR — backfill abortado:', err.message);
    process.exit(1);
  });
}

module.exports = { backfillLeadsPipeline };
