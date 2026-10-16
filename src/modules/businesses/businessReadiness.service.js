/**
 * Estado «conocimiento y material listo» por negocio (Fase 3, etapa C). SOLO LECTURA: no escribe nada y no cambia
 * ningún comportamiento; está pensado para que la pantalla «Mi negocio» lo muestre más adelante.
 *
 * Se calcula recorriendo el registro único (businessAssets.registry.js): cada entrada LEE/ENVIA debe tener un
 * evaluador acá (el test de contrato lo exige). `loaded` = el dueño cargó el dato; `connected` = el camino real del agente
 * puede usarlo hoy. Cargado pero no conectado es justo el caso silencioso que antes nadie veía (PDF sin indexar, logo
 * heredado que no se puede enviar, etc.).
 */
const Business = require('./business.model');
const Product = require('../products/product.model');
const Policy = require('../business-knowledge/policy.model');
const FAQ = require('../business-knowledge/faq.model');
const BusinessDocument = require('../business-knowledge/businessDocument.model');
const BusinessDocumentChunk = require('../business-knowledge/businessDocumentChunk.model');
const registry = require('./businessAssets.registry');
const productPhotosKey = registry.ENVIA_DE_PRODUCTO.key;

const texto = (v) => (typeof v === 'string' ? v.trim() : '');

const item = (entry, family, partial) => ({
  key: entry.key,
  family,
  section: entry.section,
  label: entry.label,
  loaded: false,
  connected: false,
  state: 'EMPTY',
  count: null,
  missing: [],
  warnings: [],
  ...partial,
});

// ── LEE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const EVALUADORES_LEE = {
  aiInstructions: async (entry, business) => {
    const loaded = Boolean(texto(business.aiInstructions));
    return item(entry, 'LEE', {
      loaded,
      connected: loaded, // buildSystemPrompt lo inyecta siempre
      state: loaded ? 'READY' : 'EMPTY',
      missing: loaded ? [] : ['Todavía no escribiste instrucciones para tu IA (opcional).'],
    });
  },

  infoPdf: async (entry, business) => {
    const subido = Boolean(texto(business.pdfUrl) || business.pdfAsset?.publicId);
    const textoExtraido = Boolean(texto(business.pdfExtractedText) || texto(business.pdfSummary));
    const [documento, chunksActivos] = await Promise.all([
      BusinessDocument.findOne({ business: business._id }).sort({ version: -1 }).select('status errorCode chunkCount version').lean(),
      BusinessDocumentChunk.countDocuments({ business: business._id, active: true }),
    ]);

    if (!subido) {
      return item(entry, 'LEE', { missing: ['Sube el PDF informativo para que tu IA pueda leerlo.'] });
    }
    if (documento?.status === 'active' && chunksActivos > 0) {
      return item(entry, 'LEE', { loaded: true, connected: true, state: 'READY', count: chunksActivos });
    }
    const enProceso = ['uploaded', 'queued', 'processing', 'ready', 'replacing'].includes(documento?.status);
    if (textoExtraido) {
      // La IA ya puede usar el texto extraído como respaldo directo, aunque el buscador del documento no esté listo.
      return item(entry, 'LEE', {
        loaded: true,
        connected: true,
        state: enProceso ? 'PROCESSING' : 'DEGRADED',
        count: chunksActivos,
        warnings: [enProceso
          ? 'El PDF se está preparando; mientras tanto tu IA usa el texto del documento.'
          : 'El PDF no se pudo indexar para búsqueda; tu IA usa el texto extraído del documento como respaldo.'],
      });
    }
    return item(entry, 'LEE', {
      loaded: true,
      connected: false,
      state: enProceso ? 'PROCESSING' : 'FAILED',
      count: chunksActivos,
      missing: [enProceso
        ? 'El PDF se está procesando; vuelve a mirar en unos minutos.'
        : 'No se pudo leer texto del PDF (puede estar escaneado o ser solo imágenes). Sube un PDF con texto.'],
    });
  },

  catalog: async (entry, business) => {
    const count = await Product.countDocuments({ business: business._id, active: true });
    return item(entry, 'LEE', {
      loaded: count > 0,
      connected: count > 0,
      state: count > 0 ? 'READY' : 'EMPTY',
      count,
      missing: count > 0 ? [] : ['Todavía no cargaste productos: tu IA no podrá confirmar precio ni stock (usará tu PDF si lo subiste).'],
    });
  },

  policies: async (entry, business) => {
    const count = await Policy.countDocuments({ business: business._id, status: 'active' });
    return item(entry, 'LEE', {
      loaded: count > 0,
      connected: count > 0,
      state: count > 0 ? 'READY' : 'EMPTY',
      count,
      missing: count > 0 ? [] : ['No hay políticas activas: tu IA no tiene reglas (garantías, cambios, pagos) que citar.'],
    });
  },

  faqs: async (entry, business) => {
    const count = await FAQ.countDocuments({ business: business._id, status: 'active' });
    return item(entry, 'LEE', {
      loaded: count > 0,
      connected: count > 0,
      state: count > 0 ? 'READY' : 'EMPTY',
      count,
      missing: count > 0 ? [] : ['No hay preguntas frecuentes activas.'],
    });
  },
};

// ── ENVIA ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const avisosDeArchivo = (entry, asset) => {
  const warnings = [];
  if (asset?.mimeType && !entry.limits.mimeTypes.includes(asset.mimeType)) {
    warnings.push(`El tipo de archivo (${asset.mimeType}) no es de los admitidos por WhatsApp para este material.`);
  }
  if (Number.isFinite(asset?.size) && asset.size > entry.limits.maxBytes) {
    warnings.push('El archivo pesa más de lo que WhatsApp permite para este tipo de material.');
  }
  return warnings;
};

const evaluarEnviable = async (entry, business) => {
  const indices = entry.multiple ? Array.from({ length: Math.max(entry.count(business), 0) }, (_, i) => i) : [0];
  const declarados = indices.filter((i) => entry.declared(business, i));
  if (!declarados.length) {
    return item(entry, 'ENVIA', { missing: [`Todavía no cargaste ${entry.multiple ? 'fotos' : `el ${entry.label}`}.`] });
  }

  const conectados = [];
  const warnings = [];
  for (const i of declarados) {
    // Enviable = la MISMA resolución que usa la tool produce una URL firmada (firma local, sin red). Un asset heredado
    // (solo URL, sin *Asset privado) o de otro negocio resuelve a null ⇒ la tool respondería asset_missing.
    let url = null;
    try { url = await entry.url(business, 'send', i); } catch { url = null; }
    if (url) {
      conectados.push(i);
      if (entry.multiple) warnings.push(...avisosDeArchivo(entry, business.photoAssets?.[i]));
    }
  }

  const sinConectar = declarados.length - conectados.length;
  return item(entry, 'ENVIA', {
    loaded: true,
    connected: conectados.length > 0,
    state: conectados.length === 0 ? 'NOT_SENDABLE' : (sinConectar > 0 ? 'PARTIAL' : 'READY'),
    count: entry.multiple ? conectados.length : null,
    missing: sinConectar > 0
      ? [`${entry.multiple ? 'Alguna foto' : `El ${entry.label}`} se subió con el sistema anterior y tu IA no puede enviarlo: vuelve a subirlo.`]
      : [],
    warnings,
  });
};

// Nombre del campo `*Asset` de Business para cada entrada de un solo archivo (para leer su metadata).
const METADATA_POR_ENTRADA = { logo: 'logoAsset', presentationVideo: 'presentationVideoAsset', brochure: 'brochureAsset' };

const estadoGlobal = (items) => {
  const cargados = items.filter((i) => i.loaded);
  if (!cargados.length) return 'EMPTY';
  return cargados.every((i) => i.connected && i.state !== 'PARTIAL' && i.state !== 'DEGRADED' && i.state !== 'PROCESSING') ? 'READY' : 'PARTIAL';
};

/**
 * @param {string|ObjectId} businessId
 * @returns {Promise<object>} estado por entrada del registro + resumen. Nunca escribe.
 */
const evaluar = async (businessId) => {
  const business = await Business.findById(businessId);
  if (!business) return null;

  const knowledgeItems = await Promise.all(registry.LEE.map((entry) => {
    const evaluador = EVALUADORES_LEE[entry.key];
    if (!evaluador) throw new Error(`businessReadiness: falta el evaluador de la entrada LEE "${entry.key}"`);
    return evaluador(entry, business);
  }));

  const productosConFoto = await Product.countDocuments({ business: business._id, active: true, 'mediaAssets.0': { $exists: true } });
  const fotosDeProducto = item(registry.ENVIA_DE_PRODUCTO, 'ENVIA', {
    loaded: productosConFoto > 0,
    connected: productosConFoto > 0, // send_product_photos las resuelve por producto (productAssetAccess)
    state: productosConFoto > 0 ? 'READY' : 'EMPTY',
    count: productosConFoto,
    missing: productosConFoto > 0 ? [] : ['Ningún producto del catálogo tiene foto: tu IA no podrá enviar la foto de un producto puntual.'],
  });

  const materialItems = (await Promise.all(registry.ENVIA.map(async (entry) => {
    const result = await evaluarEnviable(entry, business);
    if (!entry.multiple && METADATA_POR_ENTRADA[entry.key] && result.warnings.length === 0 && business[METADATA_POR_ENTRADA[entry.key]]) {
      result.warnings.push(...avisosDeArchivo(entry, business[METADATA_POR_ENTRADA[entry.key]]));
    }
    return result;
  }))).concat(fotosDeProducto);

  const knowledgeStatus = estadoGlobal(knowledgeItems);
  const materialStatus = estadoGlobal(materialItems);
  return {
    businessId: String(business._id),
    knowledge: { status: knowledgeStatus, items: knowledgeItems },
    material: { status: materialStatus, items: materialItems },
    // «Listo» = la IA tiene al menos una fuente que lee y al menos un material que puede enviar, y nada cargado está roto.
    ready: {
      knowledge: knowledgeItems.some((i) => i.connected) && !knowledgeItems.some((i) => i.loaded && !i.connected),
      material: materialItems.some((i) => i.connected) && !materialItems.some((i) => i.loaded && !i.connected),
    },
    missing: [...knowledgeItems, ...materialItems].flatMap((i) => i.missing),
    warnings: [...knowledgeItems, ...materialItems].flatMap((i) => i.warnings),
  };
};

module.exports = { evaluar, EVALUADORES_LEE };
