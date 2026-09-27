/**
 * Migración one-off — P0 de seguridad Cloudinary (auditoría Business Brain,
 * Bloque 1, 19/sep/2026). Paso 3 del rollout: migra los assets legacy
 * (logo/photos/pdfUrl/presentationVideoUrl/brochureUrl), hoy públicos y
 * permanentes en Cloudinary, a assets type:'authenticated' con acceso
 * firmado y expirable (ver businessAssetAccess.service.js, Pasos 1-2, ya
 * mergeados).
 *
 * Mecanismo (NO un rename in-place): verificado empíricamente contra un
 * asset de prueba real, en esta cuenta Free de Cloudinary, que
 * uploader.rename(..., {to_type:'authenticated', invalidate:true}) y
 * api.update(..., {access_control:[...]}) NO bloquean la URL pública vieja
 * (sigue sirviendo 200 incluso con cache-busting). uploader.destroy() sí
 * borra el asset en ORIGEN. Por eso cada asset se DESCARGA y se RESUBE como
 * un recurso nuevo con type:'authenticated' desde el origen, y recién
 * después se destruye el público viejo.
 *
 * HALLAZGO CONOCIDO, NO CIERRA EL P0 PARA ASSETS YA CON TRÁFICO REAL: el
 * destroy({invalidate:true}) borra el origen, pero el caché del CDN
 * (Fastly/Cloudflare) puede seguir sirviendo la URL vieja durante un tiempo
 * indeterminado en assets que ya habían sido vistos por tráfico real antes
 * del destroy (confirmado: un asset de prueba con solo 3 fetches se purgó
 * en ~3 min; los 7 assets reales de CREA OS/Herbalife seguían en 200 a los
 * 13 min). No afecta a ningún asset NUEVO (nunca pasan por una URL
 * pública). Ver docs/business-brain-audit/P0-cloudinary-cdn-cache-hallazgo-conocido.md
 * para la investigación completa y el chequeo manual pendiente.
 *
 * Orden de seguridad por asset (no negociable — el público viejo es la
 * única copia hasta que el nuevo esté confirmado legible):
 *   1. Descargar bytes del asset público viejo.
 *   2. Subir como authenticated nuevo.
 *   3. Generar la URL de acceso con el MISMO mecanismo real que usa el
 *      proxy (businessAssetAccess.service#generarUrlDeAcceso) y hacer un
 *      fetch real contra ella, confirmando 200.
 *   4. Solo si (3) confirma 200 -> escribir <campo>Asset en Mongo.
 *   5. Recién ahí -> destruir el público viejo.
 * Si (3) falla, no se toca Mongo ni se destruye nada — se loguea el
 * fallo de ese asset puntual y se sigue con el resto.
 *
 * Idempotencia: la acción por asset se decide mirando el estado ACTUAL en
 * Mongo, no un log aparte.
 *   - <campo>Asset.publicId ya existe -> no vuelve a descargar/subir; solo
 *     intenta destruir el público viejo (si ya no existe, Cloudinary
 *     devuelve "not found", se trata como no-op, no como error).
 *   - <campo>Asset.publicId no existe -> migración completa (1 a 5).
 * Un corte a mitad de camino nunca duplica una resubida ni destruye dos
 * veces el mismo asset.
 *
 * Dry-run por default — lista candidatos por negocio y por asset (qué se
 * va a descargar/re-subir/destruir) antes de escribir nada. Solo escribe
 * con la flag --confirm.
 *
 * Uso:
 *   node scripts/migrate-business-assets-authenticated.js           # dry-run
 *   node scripts/migrate-business-assets-authenticated.js --confirm # aplica
 *
 * Requiere MONGODB_URI_PROD y credenciales de Cloudinary en .env — corre
 * contra producción a propósito.
 */
const { cloudinary, extraerPublicId } = require('../src/utils/cloudinary');
const { generarUrlDeAcceso } = require('../src/modules/businesses/businessAssetAccess.service');
const path = require('path');

const COLLECTION_NAME = 'businesses';
const EXTENSION_POR_TIPO = { image: 'jpg', video: 'mp4', raw: 'pdf' };

// campo lógico -> {campoUrlLegacy, campoAsset} para los 4 campos simples.
// "photos"/"photoAssets" son un array, se maneja aparte (migrarFotos).
const CAMPOS_SIMPLES = {
  logo: { campoUrl: 'logo', campoAsset: 'logoAsset' },
  pdf: { campoUrl: 'pdfUrl', campoAsset: 'pdfAsset' },
  presentationVideo: { campoUrl: 'presentationVideoUrl', campoAsset: 'presentationVideoAsset' },
  brochure: { campoUrl: 'brochureUrl', campoAsset: 'brochureAsset' },
};

/**
 * Descarga los bytes de una URL pública de Cloudinary.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function descargarBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga falló: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: res.headers?.get?.('content-type') || null, size: buffer.length };
}

/**
 * Sube un buffer como asset NUEVO type:'authenticated'.
 * @param {Buffer} buffer
 * @param {string} resourceType
 * @returns {Promise<{publicId: string, resourceType: string}>}
 */
async function subirComoAuthenticated(buffer, resourceType, metadata = {}) {
  const resultado = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, type: 'authenticated', folder: 'creaos/business-assets' },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
  if (resultado.type !== 'authenticated') {
    throw new Error(`Cloudinary respondió delivery inesperado: ${resultado.type || 'sin type'}`);
  }
  const ahora = new Date();
  return {
    asset: {
      publicId: resultado.public_id,
      resourceType: resultado.resource_type,
      deliveryType: resultado.type,
      format: resultado.format || metadata.format || null,
      mimeType: metadata.mimeType || null,
      originalName: metadata.originalName || null,
      size: resultado.bytes ?? metadata.size ?? null,
      status: 'active',
      createdAt: resultado.created_at ? new Date(resultado.created_at) : ahora,
      updatedAt: ahora,
    },
    locator: resultado.secure_url?.includes('/authenticated/')
      ? resultado.secure_url
      : `cloudinary-authenticated://${resultado.public_id}`,
  };
}

/**
 * Confirma que el asset recién subido es realmente legible vía el MISMO
 * mecanismo que usará el proxy en producción — no alcanza con que la
 * resubida haya devuelto 200.
 * @param {{publicId: string, resourceType: string}} assetNuevo
 * @returns {Promise<boolean>}
 */
async function verificarLegible(assetNuevo) {
  const url = generarUrlDeAcceso({ ...assetNuevo, tipoEntrega: 'authenticated' }, 'display');
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return true;
    // Algunos endpoints de Cloudinary no soportan HEAD — reintenta con GET.
    const resGet = await fetch(url);
    return resGet.ok;
  } catch {
    return false;
  }
}

/**
 * Destruye un asset viejo por public_id/resourceType. Trata "not found"
 * como no-op (ya destruido en una corrida anterior), no como error.
 * @param {{publicId: string, resourceType: string}} datosViejo
 */
async function destruirSiExiste(datosViejo) {
  const resultado = await cloudinary.uploader.destroy(datosViejo.publicId, {
    resource_type: datosViejo.resourceType,
    type: 'upload',
    invalidate: true,
  });
  return resultado.result; // 'ok' | 'not found'
}

/**
 * Decide y ejecuta (o solo describe, en dry-run) la migración de un asset
 * individual. Único punto de entrada compartido por los 4 campos simples
 * y por cada foto del array.
 * @param {{campoUrl: string, urlVieja: string|undefined, assetActual: {publicId?: string, resourceType?: string}|undefined}} entrada
 * @param {{confirm: boolean}} opts
 * @returns {Promise<{campo: string, accion: string, detalle?: string, ok?: boolean}>}
 */
async function migrarAsset({ etiqueta, urlVieja, assetActual }, { confirm }) {
  const yaEsPrivado = assetActual?.publicId && assetActual.deliveryType === 'authenticated';
  const datosViejo = assetActual?.legacyPublicId
    ? { publicId: assetActual.legacyPublicId, resourceType: assetActual.legacyResourceType || assetActual.resourceType }
    : (urlVieja ? extraerPublicId(urlVieja) : null);
  if (yaEsPrivado && (!datosViejo || assetActual.legacyRetiredAt)) {
    return { campo: etiqueta, accion: 'nada', detalle: 'asset authenticated sin origen público pendiente' };
  }
  if (!urlVieja && !datosViejo) return { campo: etiqueta, accion: 'nada', detalle: 'sin asset cargado' };
  if (!datosViejo) {
    return { campo: etiqueta, accion: 'nada', detalle: `URL no reconocible: ${urlVieja}` };
  }

  // Ya migrado (asset nuevo ya existe) -> solo falta confirmar que el
  // público viejo esté destruido (idempotencia de una corrida anterior).
  if (yaEsPrivado) {
    if (!confirm) {
      return {
        campo: etiqueta,
        accion: 'verificar_y_destruir_viejo',
        detalle: `ya migrado (${assetActual.publicId}) — solo falta confirmar destroy de ${datosViejo.publicId}`,
      };
    }
    try {
      const resultado = await destruirSiExiste(datosViejo);
      return {
        campo: etiqueta,
        accion: 'destroy_viejo',
        ok: true,
        retirarLegacy: true,
        locatorNuevo: `cloudinary-authenticated://${assetActual.publicId}`,
        detalle: `destroy(${datosViejo.publicId}) -> ${resultado}`,
      };
    } catch (error) {
      return { campo: etiqueta, accion: 'destroy_viejo', ok: false, detalle: `error al destruir ${datosViejo.publicId}: ${error.message}` };
    }
  }

  if (!confirm) {
    return {
      campo: etiqueta,
      accion: 'migrar_completo',
      detalle: `descargar ${urlVieja} -> subir authenticated -> verificar vía proxy -> destroy(${datosViejo.publicId})`,
    };
  }

  // Aislado en try/catch a propósito: un asset roto/inaccesible (ej. una
  // URL vieja ya inválida en la BD, ajena a esta migración) no debe
  // abortar el resto del negocio ni de los negocios siguientes — se
  // reporta como fallo puntual y se sigue. Nunca se llega a tocar Mongo
  // ni a destruir nada del lado del viejo si algo de esto falla.
  try {
    const descarga = await descargarBytes(urlVieja);
    const originalName = decodeURIComponent(path.basename(new URL(urlVieja).pathname));
    const format = path.extname(originalName).slice(1).toLowerCase() || null;
    const subida = await subirComoAuthenticated(descarga.buffer, datosViejo.resourceType, {
      mimeType: descarga.mimeType,
      originalName,
      format,
      size: descarga.size,
    });
    const assetNuevo = {
      ...subida.asset,
      legacyPublicId: datosViejo.publicId,
      legacyResourceType: datosViejo.resourceType,
      legacyRetiredAt: null,
    };

    const legible = await verificarLegible(assetNuevo);
    if (!legible) {
      return {
        campo: etiqueta,
        accion: 'migrar_completo',
        ok: false,
        detalle: `subido (${assetNuevo.publicId}) pero NO se pudo confirmar legible vía proxy — NO se tocó Mongo ni se destruyó el viejo`,
      };
    }

    return {
      campo: etiqueta,
      accion: 'migrar_completo',
      ok: true,
      assetNuevo,
      locatorNuevo: subida.locator,
      detalle: `migrado: ${datosViejo.publicId} -> ${assetNuevo.publicId} (verificado legible, listo para escribir + destruir viejo)`,
    };
  } catch (error) {
    return {
      campo: etiqueta,
      accion: 'migrar_completo',
      ok: false,
      detalle: `falló (${error.message}) — asset viejo probablemente roto/inaccesible, sin relación con esta migración; NO se tocó Mongo ni se destruyó nada`,
    };
  }
}

/**
 * Procesa un negocio completo: los 4 campos simples + el array de fotos.
 * En modo --confirm, escribe en Mongo y destruye el viejo inmediatamente
 * después de cada asset exitoso (no al final del negocio) — así un corte
 * a mitad de un negocio con varios assets dej ya los anteriores completos
 * y consistentes.
 * @param {import('mongodb').Collection} collection
 * @param {any} business
 * @param {{confirm: boolean}} opts
 */
async function migrarNegocio(collection, business, { confirm }) {
  const resultados = [];

  for (const [campo, { campoUrl, campoAsset }] of Object.entries(CAMPOS_SIMPLES)) {
    const resultado = await migrarAsset(
      { etiqueta: campo, urlVieja: business[campoUrl], assetActual: business[campoAsset] },
      { confirm }
    );
    resultados.push(resultado);
    if (confirm && resultado.ok && resultado.retirarLegacy) {
      await collection.updateOne(
        { _id: business._id },
        { $set: { [campoUrl]: resultado.locatorNuevo, [`${campoAsset}.legacyRetiredAt`]: new Date() } }
      );
    }
    if (confirm && resultado.ok && resultado.assetNuevo) {
      resultado.assetNuevo.businessId = business._id;
      await collection.updateOne(
        { _id: business._id },
        { $set: { [campoAsset]: resultado.assetNuevo, [campoUrl]: resultado.locatorNuevo } }
      );
      const datosViejo = extraerPublicId(business[campoUrl]);
      try {
        await destruirSiExiste(datosViejo);
        await collection.updateOne(
          { _id: business._id },
          { $set: { [`${campoAsset}.legacyRetiredAt`]: new Date() } }
        );
      } catch (error) {
        // El nuevo asset ya está escrito y verificado legible — que falle el
        // destroy del viejo no debe abortar el resto de la migración. Queda
        // un asset público viejo sin destruir (P0 sin cerrar del todo para
        // este campo puntual), pero se loguea, no se pierde nada.
        resultado.detalle += ` | ⚠️ error al destruir el viejo (${datosViejo?.publicId}): ${error.message}`;
      }
    }
  }

  const fotos = business.photos || [];
  for (let i = 0; i < fotos.length; i += 1) {
    const etiqueta = `photo[${i}]`;
    const assetActual = business.photoAssets?.[i];
    const resultado = await migrarAsset({ etiqueta, urlVieja: fotos[i], assetActual }, { confirm });
    resultados.push(resultado);
    if (confirm && resultado.ok && resultado.retirarLegacy) {
      const photosActualizadas = [...fotos];
      photosActualizadas[i] = resultado.locatorNuevo;
      await collection.updateOne(
        { _id: business._id },
        { $set: { photos: photosActualizadas, [`photoAssets.${i}.legacyRetiredAt`]: new Date() } }
      );
      fotos[i] = resultado.locatorNuevo;
    }
    if (confirm && resultado.ok && resultado.assetNuevo) {
      const photoAssets = [...(business.photoAssets || [])];
      const photosActualizadas = [...fotos];
      resultado.assetNuevo.businessId = business._id;
      photoAssets[i] = resultado.assetNuevo;
      photosActualizadas[i] = resultado.locatorNuevo;
      await collection.updateOne({ _id: business._id }, { $set: { photoAssets, photos: photosActualizadas } });
      business.photoAssets = photoAssets; // mantiene el documento en memoria consistente entre fotos del mismo negocio
      fotos[i] = resultado.locatorNuevo;
      const datosViejo = extraerPublicId(fotos[i]);
      try {
        await destruirSiExiste(datosViejo);
        await collection.updateOne(
          { _id: business._id },
          { $set: { [`photoAssets.${i}.legacyRetiredAt`]: new Date() } }
        );
      } catch (error) {
        resultado.detalle += ` | ⚠️ error al destruir el viejo (${datosViejo?.publicId}): ${error.message}`;
      }
    }
  }

  return resultados;
}

/**
 * Orquesta el dry-run/confirm sobre todos los negocios.
 * @param {import('mongodb').Collection} collection
 * @param {{confirm?: boolean}} [opts]
 */
async function run(collection, { confirm = false, summaryOnly = false } = {}) {
  const negocios = await collection.find({}).toArray();
  let totalAcciones = 0;
  let totalNegociosConAcciones = 0;

  for (const business of negocios) {
    const resultados = await migrarNegocio(collection, business, { confirm });
    const accionable = resultados.filter((r) => r.accion !== 'nada');

    if (!summaryOnly) console.log(`\n${business.name} (${business._id})`);
    if (accionable.length === 0) {
      if (!summaryOnly) console.log('   sin assets — nada que migrar');
      continue;
    }
    totalNegociosConAcciones += 1;
    for (const r of accionable) {
      totalAcciones += 1;
      const marca = confirm ? (r.ok === false ? '❌' : '✅') : '🔎';
      if (!summaryOnly) console.log(`   ${marca} [${r.campo}] ${r.accion} — ${r.detalle}`);
    }
  }

  if (!confirm) {
    console.log(`\n🔎 Dry-run (default) — ${totalAcciones} acción(es) listada(s), no se escribió ni se destruyó nada.`);
    console.log(`Negocios con candidatos: ${totalNegociosConAcciones}. Corré con --confirm para aplicar.`);
  } else {
    console.log(`\n✅ Migración aplicada — ${totalAcciones} acción(es) procesada(s).`);
  }

  return { totalAcciones, totalNegociosConAcciones };
}

module.exports = {
  COLLECTION_NAME,
  CAMPOS_SIMPLES,
  descargarBytes,
  subirComoAuthenticated,
  verificarLegible,
  destruirSiExiste,
  migrarAsset,
  migrarNegocio,
  run,
};

if (require.main === module) {
  const dns = require('dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  require('dotenv').config();
  const mongoose = require('mongoose');

  (async () => {
    const uri = process.env.MONGODB_URI_PROD;
    if (!uri) throw new Error('MONGODB_URI_PROD no está en .env');

    const confirm = process.argv.includes('--confirm');

    await mongoose.connect(uri);
    console.log(`✅ Conectado a producción (${confirm ? 'ESCRIBIENDO' : 'solo lectura / dry-run'})`);

    const collection = mongoose.connection.db.collection(COLLECTION_NAME);
    const summaryOnly = process.argv.includes('--summary-only');
    await run(collection, { confirm, summaryOnly });

    await mongoose.disconnect();
  })().catch((err) => {
    console.error('❌ ERROR — migración abortada:', err.message);
    process.exit(1);
  });
}
