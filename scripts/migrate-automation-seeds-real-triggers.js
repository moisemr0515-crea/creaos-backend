/**
 * Migración de las automatizaciones semilla existentes ("Seguimientos
 * automáticos"/"Cierre automático") al shape real cableado en el Caso 5
 * del backlog (PR C/6) — antes de este script, cualquier negocio que ya
 * hubiera visitado la pantalla de Automatizaciones (o "Mi Negocio", que
 * sigue pidiendo el límite de plan aunque el toggle esté oculto) tiene
 * estos 2 documentos Automation persistidos con trigger.type:'manual'
 * congelado para siempre: automation.service.js#
 * asegurarAutomatizacionesSemilla() usa $setOnInsert (upsert), que solo
 * aplica en la CREACIÓN — cambiar el array AUTOMATIZACIONES_SEMILLA en el
 * código (PR C) no toca ningún documento ya persistido.
 *
 * Query previa que se había previsto para dimensionar el riesgo
 * (Automation.find({type:{$in:['followup','auto_close']}, isActive:true}))
 * NO se pudo correr contra producción desde el entorno donde se escribió
 * este script — sin acceso a MONGODB_URI_PROD ahí. Decisión explícita:
 * seguir igual, confiando en que el script es seguro sin importar el
 * resultado (idempotente, no pisa ediciones del usuario, salta lo que no
 * puede resolver sin bloquear el resto) — correrlo una vez con
 * MONGODB_URI_PROD real y revisar el resumen que imprime al final es el
 * chequeo real.
 *
 * Alcance: SOLO actualiza documentos con trigger.type:'manual' (el shape
 * viejo) — no toca ninguno que ya esté en el shape nuevo (ej. un negocio
 * sembrado DESPUÉS de que el PR C se desplegara). Idempotente por la
 * propia query: correrlo 2 veces no hace nada la segunda vez (la query ya
 * no encuentra nada para migrar).
 *
 * Preserva nombre/descripción editados a mano: si `name`/`description` ya
 * no coinciden con el placeholder viejo EXACTO, se asume que el usuario
 * los editó (única forma posible hoy — no hay, ni había, UI para tocar
 * trigger/actions directamente) y se dejan como están; solo se actualiza
 * `trigger`/`actions` (el mecanismo, que el usuario nunca pudo haber
 * personalizado desde la UI).
 *
 * 'auto_close' reusa resolverAccionesSemilla() (automation.service.js) —
 * misma resolución de la etapa "ganada" real del pipeline de CADA negocio
 * que ya usa el seed de negocios nuevos (PR C), sin duplicarla acá. Un
 * negocio sin ninguna etapa "ganada" configurada se saltea (se loguea, no
 * bloquea el resto) — mismo criterio ya validado en el PR C.
 *
 * No se integra al arranque de la app ni a ningún flujo automático —
 * corre una sola vez, manual, contra producción.
 *
 * La lógica de migración vive en migrarAutomatizacionesSemilla(),
 * exportada aparte del bloque de conexión/CLI (guardado con
 * `require.main === module`) para poder testearla con Mongo real sin
 * depender de MONGODB_URI_PROD ni de process.exit — ver el .test.js al
 * lado.
 *
 * Uso: node scripts/migrate-automation-seeds-real-triggers.js
 * Requiere MONGODB_URI_PROD en .env — mismo patrón que
 * migrate-crea-os-pipeline-5-stages.js.
 */
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']); // mismo override que plans.seed.js / la migración de pipeline — el DNS local falla contra el SRV de Atlas

require('dotenv').config();
const mongoose = require('mongoose');

// Placeholder viejo EXACTO (pre-PR C) — usado solo para detectar si el
// usuario editó name/description a mano. Copiado tal cual de la versión
// anterior de AUTOMATIZACIONES_SEMILLA, no re-derivado de nada, para no
// depender de que el código viejo siga existiendo en el repo.
const PLACEHOLDER_VIEJO = {
  followup: {
    name: 'Seguimientos automáticos',
    description:
      'Placeholder — la lógica real de "leads sin seguimiento hace N días" necesita un trigger por tiempo que aún no existe en el motor. Actívala cuando esa pieza esté lista.',
  },
  auto_close: {
    name: 'Cierre automático',
    description:
      'Placeholder — la lógica real de cierre automático de oportunidades avanzadas necesita un trigger por tiempo/probabilidad que aún no existe en el motor.',
  },
};

/**
 * Corre la migración completa contra la conexión Mongo ya activa (el
 * caller es responsable de conectar/desconectar — así el .test.js puede
 * apuntar a una base de test sin tocar nada de esto).
 * @returns {Promise<{total:number, migradas:number, saltadas:number, editadasPreservadas:number}>}
 */
async function migrarAutomatizacionesSemilla() {
  const Automation = require('../src/modules/automations/automation.model');
  const { AUTOMATIZACIONES_SEMILLA, resolverAccionesSemilla } = require('../src/modules/automations/automation.service');

  const viejas = await Automation.find({
    type: { $in: ['followup', 'auto_close'] },
    'trigger.type': 'manual',
  });

  console.log(`Encontradas ${viejas.length} automatizaciones semilla con el shape viejo (trigger.type:'manual').`);

  let migradas = 0;
  let saltadas = 0;
  let editadasPreservadas = 0;

  for (const automation of viejas) {
    const semilla = AUTOMATIZACIONES_SEMILLA.find((s) => s.type === automation.type);
    if (!semilla) {
      console.warn(`  ⚠️  ${automation._id} tiene type:"${automation.type}" sin semilla correspondiente — se salta (no debería pasar).`);
      saltadas++;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- migración secuencial a propósito, volumen bajo (2 docs por negocio)
    const actions = await resolverAccionesSemilla(automation.business, automation.createdBy, semilla);
    if (!actions) {
      console.warn(
        `  ⚠️  ${automation._id} (${automation.type}, negocio ${automation.business}) se salta — sin acciones válidas ` +
        `para este negocio (ver el log de resolverAccionesSemilla arriba, ej. sin etapa "ganada" en su pipeline).`
      );
      saltadas++;
      continue;
    }

    const placeholder = PLACEHOLDER_VIEJO[automation.type];
    const editadaPorUsuario = automation.name !== placeholder.name || automation.description !== placeholder.description;

    const update = { trigger: semilla.trigger, actions };
    if (!editadaPorUsuario) {
      update.name = semilla.name;
      update.description = semilla.description;
    } else {
      editadasPreservadas++;
    }

    // eslint-disable-next-line no-await-in-loop
    await Automation.findByIdAndUpdate(automation._id, { $set: update });
    migradas++;
    console.log(
      `  ✅ ${automation._id} (${automation.type}, negocio ${automation.business}) migrada — trigger.type:'${semilla.trigger.type}'` +
      (editadaPorUsuario ? ' (name/description preservados, editados a mano)' : '')
    );
  }

  const restantes = await Automation.countDocuments({ type: { $in: ['followup', 'auto_close'] }, 'trigger.type': 'manual' });

  return { total: viejas.length, migradas, saltadas, editadasPreservadas, restantes };
}

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI_PROD;
    if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');
    await mongoose.connect(uri);

    const resumen = await migrarAutomatizacionesSemilla();

    if (resumen.total === 0) {
      console.log('Nada para migrar — saliendo.');
    } else {
      console.log(`\nResumen: ${resumen.migradas} migradas (${resumen.editadasPreservadas} con name/description preservados), ${resumen.saltadas} saltadas de ${resumen.total} encontradas.`);
      if (resumen.restantes > 0) {
        console.warn(`⚠️  Quedan ${resumen.restantes} automatizaciones semilla todavía con trigger.type:'manual' — esperado si coincide con "saltadas" de arriba, revisar si no.`);
      } else {
        console.log('✅ Ninguna automatización semilla quedó con el shape viejo.');
      }
    }

    await mongoose.disconnect();
  })().catch((err) => {
    console.error('ERROR — migración abortada:', err.message);
    process.exit(1);
  });
}

module.exports = { migrarAutomatizacionesSemilla, PLACEHOLDER_VIEJO };
