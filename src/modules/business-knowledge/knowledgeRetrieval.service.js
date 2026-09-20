const mongoose = require('mongoose');
const Policy = require('./policy.model');
const FAQ = require('./faq.model');
const BusinessDocumentChunk = require('./businessDocumentChunk.model');
const { generarEmbedding } = require('../../utils/embeddings');
const { descartarClaimsDePrecioStockDesactualizados } = require('./priceStockGuard.service');
const logger = require('../../utils/logger');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 3/11
// (retrieval con hard filters) + Etapa 4/11 (precedencia, ranking y
// detección de conflicto/ambigüedad — resolverConocimiento(), más abajo).
// Este archivo es el ÚNICO punto de retrieval que va a consumir la tool
// de la IA (Etapa 6) — nunca policy.service.js/faq.service.js
// directamente, que son CRUD de administración sin garantía de
// vigencia/estado.
//
// Documento §11.2/§4.1: "los filtros de tenant, estado y vigencia no
// deben depender del prompt" — todo lo de acá pasa en la QUERY de Mongo,
// nunca se filtra después en JS sobre resultados ya traídos. Mismo
// principio que ya aplican buscarProductos()/obtenerTablero().

// Documento §9: un registro es elegible si status=='active' Y (sin
// effectiveFrom O effectiveFrom<=ahora) Y (sin effectiveUntil O
// effectiveUntil>=ahora). `effectiveFrom`/`effectiveUntil` tienen
// `default: null` en el schema (policy.model.js/faq.model.js) — un
// documento que nunca los seteó los tiene guardados como `null` de
// verdad (no "ausentes"), así que alcanza con comparar contra `null`,
// sin necesitar `$exists:false` como rama aparte.
const construirFiltroElegible = (businessId) => {
  const ahora = new Date();
  return {
    business: businessId,
    status: 'active',
    $and: [
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: ahora } }] },
      { $or: [{ effectiveUntil: null }, { effectiveUntil: { $gte: ahora } }] },
    ],
  };
};

// Tope de candidatos por colección — sin ranking todavía (Etapa 4), así
// que esto NO es "los N mejores resultados", es "como mucho N candidatos
// para que la Etapa 4 rankee" — igual de acotado que
// LIMITE_RESULTADOS_BUSQUEDA de product.service.js, mismo motivo (no
// meter un catálogo entero en el contexto de la IA, documento §19).
const LIMITE_CANDIDATOS = 20;

// Bloque 3 de la auditoría Business Brain (§51/§53, 20/sep/2026) —
// retrieval semántico, capa ADICIONAL sobre el $text existente arriba,
// nunca en su reemplazo (fase 2, punto 4, aprobado). numCandidates:
// sobre-muestreo recomendado por Atlas antes de recortar — no es el
// límite final de resultados. UMBRAL_SIMILITUD: piso de similitud coseno
// por debajo del cual un candidato NO se considera un match real (Atlas
// siempre devuelve los K vecinos más cercanos, sean relevantes o no) —
// valor de arranque, ajustable empíricamente una vez que haya tráfico
// real (Fase 2, punto 3).
const NUM_CANDIDATOS_VECTOR = 100;
const UMBRAL_SIMILITUD_SEMANTICA = 0.75;
// K de chunks del PDF por búsqueda — mismo criterio que LIMITE_CANDIDATOS
// de arriba, deliberadamente chico (Fase 2, punto 3).
const K_CHUNKS_DOCUMENTO = 5;

/**
 * Corre $vectorSearch sobre `Model` con el filtro estructural YA resuelto
 * (`filtro`, sin `$text` — Atlas no combina ambos en la misma etapa) y le
 * aplica el piso de similitud. Devuelve [] sin lanzar si `queryEmbedding`
 * es null (ej. generarEmbedding() falló más arriba) — el caller sigue
 * teniendo los resultados de texto igual, nunca se cae el retrieval
 * entero por esto.
 */
const buscarSemantico = async (Model, indexName, filtro, queryEmbedding) => {
  if (!queryEmbedding) return [];

  try {
    const resultados = await Model.aggregate([
      {
        $vectorSearch: {
          index: indexName,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: NUM_CANDIDATOS_VECTOR,
          limit: LIMITE_CANDIDATOS,
          filter: filtro,
        },
      },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
    ]);
    return resultados.filter((r) => r.score >= UMBRAL_SIMILITUD_SEMANTICA);
  } catch (error) {
    // Fail-soft: si el índice todavía no terminó de construirse en Atlas
    // (status PENDING) o cualquier otro problema transitorio, el
    // retrieval sigue funcionando solo con texto — nunca se cae la
    // respuesta entera por esto.
    logger.warn(`[knowledgeRetrieval] $vectorSearch falló sobre ${Model.collection.name} (se continúa solo con texto): ${error.message}`);
    return [];
  }
};

/** Une candidatos de texto + semántico por `_id`, sin duplicar. */
const combinarCandidatos = (deTexto, deSemantico) => {
  const porId = new Map(deTexto.map((doc) => [String(doc._id), doc]));
  for (const doc of deSemantico) {
    if (!porId.has(String(doc._id))) porId.set(String(doc._id), doc);
  }
  return [...porId.values()];
};

/**
 * Busca Policies y FAQs elegibles para un negocio — hard filters de
 * tenant+status+vigencia SIEMPRE aplicados; `texto`/`productIds`/
 * `channelId` son opcionales y acotan más, nunca reemplazan el filtro
 * base. Sin precedencia ni conflict-detection todavía (Etapa 4) — el
 * orden de retorno es por `textScore` si hay búsqueda de texto, o por
 * `priority` descendente si no.
 *
 * FAQ.scope V1 no tiene `productIds` propio (documento §7 — la relación
 * con un producto puntual es `linkedProductIds`, no `scope`; ver
 * faq.model.js) — por eso `productIds` solo acota el `$or` de Policy, no
 * el de FAQ. Usar `linkedProductIds` para priorizar FAQs relacionadas a
 * un producto queda para el ranking de la Etapa 4, no es un hard filter.
 *
 * @param {string} businessId
 * @param {string} [texto] — búsqueda de texto libre (opcional)
 * @param {{ productIds?: string[], channelId?: string }} [contexto]
 */
const buscarConocimiento = async (businessId, texto, { productIds = [], channelId } = {}) => {
  const filtroElegible = construirFiltroElegible(businessId);

  const scopeOrPolicy = [
    { 'scope.appliesToAll': true },
    ...(productIds.length ? [{ 'scope.productIds': { $in: productIds } }] : []),
    ...(channelId ? [{ 'scope.channelIds': channelId }] : []),
  ];
  const scopeOrFAQ = [
    { 'scope.appliesToAll': true },
    ...(channelId ? [{ 'scope.channelIds': channelId }] : []),
  ];

  // Filtro ESTRUCTURAL puro (tenant+status+vigencia+scope), SIN $text —
  // este es el que se le pasa a $vectorSearch (Bloque 3, §53): Atlas no
  // combina $text y $vectorSearch en la misma etapa, así que la búsqueda
  // semántica corre como una consulta aparte con este mismo filtro, nunca
  // uno más permisivo.
  const queryEstructuralPolicy = { ...filtroElegible, $or: scopeOrPolicy };
  const queryEstructuralFAQ = { ...filtroElegible, $or: scopeOrFAQ };

  const hayTexto = Boolean(texto && texto.trim());

  const queryTextoPolicy = hayTexto ? { ...queryEstructuralPolicy, $text: { $search: texto } } : null;
  const queryTextoFAQ = hayTexto ? { ...queryEstructuralFAQ, $text: { $search: texto } } : null;

  const proyeccionTexto = { score: { $meta: 'textScore' } };

  // Sin texto: mismo comportamiento de siempre (Etapa 3), sin búsqueda
  // semántica (no hay ninguna query que embeber) — orden por priority.
  if (!hayTexto) {
    const [policies, faqs] = await Promise.all([
      Policy.find(queryEstructuralPolicy).sort({ priority: -1 }).limit(LIMITE_CANDIDATOS).lean(),
      FAQ.find(queryEstructuralFAQ).sort({ priority: -1 }).limit(LIMITE_CANDIDATOS).lean(),
    ]);
    return { policies, faqs };
  }

  // Con texto: corre $text y $vectorSearch en paralelo, se combinan sin
  // duplicar. Un fallo generando el embedding de la query (OpenAI caído)
  // no tumba nada — buscarSemantico() ya devuelve [] en ese caso, el
  // resultado final queda igual al de antes de este bloque (solo texto).
  const [queryEmbedding, policiesTexto, faqsTexto] = await Promise.all([
    generarEmbedding(texto).catch((error) => {
      logger.warn(`[knowledgeRetrieval] No se pudo generar el embedding de la query (se continúa solo con texto): ${error.message}`);
      return null;
    }),
    Policy.find(queryTextoPolicy, proyeccionTexto).sort({ score: { $meta: 'textScore' } }).limit(LIMITE_CANDIDATOS).lean(),
    FAQ.find(queryTextoFAQ, proyeccionTexto).sort({ score: { $meta: 'textScore' } }).limit(LIMITE_CANDIDATOS).lean(),
  ]);

  const [policiesSemantico, faqsSemantico] = await Promise.all([
    buscarSemantico(Policy, 'policy_vector_index', queryEstructuralPolicy, queryEmbedding),
    buscarSemantico(FAQ, 'faq_vector_index', queryEstructuralFAQ, queryEmbedding),
  ]);

  return {
    policies: combinarCandidatos(policiesTexto, policiesSemantico),
    faqs: combinarCandidatos(faqsTexto, faqsSemantico),
  };
};

/**
 * Bloque 3 (§45-51, 20/sep/2026) — top-K chunks del PDF del negocio, vía
 * $vectorSearch (nunca $text: los chunks no tienen índice de texto, la
 * ingesta los pensó para retrieval semántico desde el día uno). Filtro
 * estructural: SOLO el chunk activo de ESTE negocio (`active` es el único
 * campo que decide si un chunk participa, ver businessDocumentChunk.model.js)
 * — nunca un $lookup a BusinessDocument.
 */
const buscarChunksDocumento = async (businessId, texto) => {
  if (!texto || !texto.trim()) return [];

  const queryEmbedding = await generarEmbedding(texto).catch((error) => {
    logger.warn(`[knowledgeRetrieval] No se pudo generar el embedding de la query para chunks del PDF: ${error.message}`);
    return null;
  });
  if (!queryEmbedding) return [];

  const resultados = await buscarSemantico(
    BusinessDocumentChunk,
    'chunk_vector_index',
    { business: businessId, active: true },
    queryEmbedding
  );

  return resultados.slice(0, K_CHUNKS_DOCUMENTO);
};

// ---------------------------------------------------------------------
// Etapa 4/11 — precedencia, ranking y resolución de conflictos.
// Documento §10:
//   Orden de precedencia V1:
//     1. Policy específica aplicable
//     2. Policy general aplicable
//     3. FAQ vinculada a Policy
//     4. FAQ independiente
//     5. fallback/handoff (sin resultados)
//   Dentro del mismo nivel: (a) scope más específico, (b) prioridad más
//   alta, (c) versión vigente más reciente, (d) si persiste conflicto
//   material → no improvisar, pedir aclaración o derivar.
// ---------------------------------------------------------------------

/**
 * Ordena Policies ya elegibles (hard-filtradas) según la precedencia del
 * documento §10: primero TODAS las de scope específico (appliesToAll:
 * false — ya vinieron filtradas por buscarConocimiento() para matchear el
 * contexto dado), después las generales (appliesToAll:true); dentro de
 * cada grupo, priority descendente y como desempate version descendente,
 * y como último desempate updatedAt descendente ("versión vigente más
 * reciente" — documento §10 regla 3).
 */
const rankearPolicies = (policies) => {
  const especificas = policies.filter((p) => p.scope?.appliesToAll === false);
  const generales = policies.filter((p) => p.scope?.appliesToAll !== false);

  const compararPrecedencia = (a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.version !== a.version) return b.version - a.version;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  };

  return [...especificas.sort(compararPrecedencia), ...generales.sort(compararPrecedencia)];
};

/**
 * Ordena FAQs ya elegibles: primero las vinculadas a alguna de las
 * Policies candidatas (documento §10 nivel 3, "FAQ vinculada a Policy"),
 * después las independientes (nivel 4) — dentro de cada grupo, priority
 * descendente.
 */
const rankearFAQs = (faqs, policiesRankeadas) => {
  const idsPoliciesCandidatas = new Set(policiesRankeadas.map((p) => p._id.toString()));
  const vinculadas = [];
  const independientes = [];

  for (const faq of faqs) {
    const estaVinculada = (faq.linkedPolicyIds || []).some((id) => idsPoliciesCandidatas.has(id.toString()));
    (estaVinculada ? vinculadas : independientes).push(faq);
  }

  const porPriorityDesc = (a, b) => b.priority - a.priority;
  return [...vinculadas.sort(porPriorityDesc), ...independientes.sort(porPriorityDesc)];
};

/**
 * TC-08 (documento §23): "la devolución depende del producto y no se
 * conoce producto — debe preguntar cuál". buscarConocimiento() solo
 * puede matchear una Policy de scope específico si el contexto YA trae
 * el/los productId — si no se conoce el producto, esas Policies nunca
 * aparecen como candidatas, y devolver solo la Policy general sería dar
 * una respuesta que podría no aplicar. Por eso, cuando no hay
 * `productIds` en el contexto, se hace una segunda consulta (ignorando
 * el scope) para detectar si el tema tiene variantes por producto en las
 * categorías de las Policies generales que sí matchearon.
 *
 * Criterio deliberadamente conservador (documento §4.3 "no alucinar" +
 * §10 regla 4 "si persiste conflicto material, no improvisar"): alcanza
 * con que exista AL MENOS UNA variante específica por producto para
 * pedir aclaración, en vez de asumir que la Policy general sí aplica.
 */
const detectarAmbiguedadPorProducto = async (businessId, texto, policiesGeneralesMatcheadas) => {
  if (!policiesGeneralesMatcheadas.length) return false;
  if (!texto || !texto.trim()) return false;

  const categorias = [...new Set(policiesGeneralesMatcheadas.map((p) => p.category))];
  const filtroElegible = construirFiltroElegible(businessId);
  const query = {
    ...filtroElegible,
    'scope.appliesToAll': false,
    'scope.productIds.0': { $exists: true },
    category: { $in: categorias },
    $text: { $search: texto },
  };

  const variantes = await Policy.find(query).select('_id').lean();
  return variantes.length > 0;
};

/**
 * TC-10 (documento §23): "FAQ antigua dice 15 días, Policy activa dice 7
 * días — Policy gana y se registra conflicto". No hay forma confiable de
 * comparar semánticamente dos textos libres sin LLM en V1, así que el
 * criterio es estructural y deliberadamente conservador: una FAQ
 * INDEPENDIENTE (no vinculada vía linkedPolicyIds) que comparte la misma
 * `category` que la Policy ganadora es una señal suficiente de posible
 * contenido desactualizado/contradictorio como para registrarlo — la
 * Policy igual gana la respuesta (documento §5.3), esto solo decide si
 * se loguea como conflicto para revisión humana.
 *
 * Nota: la taxonomía de categorías de Policy y de FAQ son independientes
 * (documento §5, 14 vs 12 categorías) y solo se comparan por el valor
 * literal en común (p. ej. "returns", "payments", "warranty", "other")
 * — un solape de categoría con nombres distintos entre ambas taxonomías
 * (p. ej. Policy "shipping_delivery" vs FAQ "delivery") no se detecta en
 * V1. Documentado como limitación conocida, no bloqueante.
 */
const detectarConflictoConFAQIndependiente = (policyGanadora, faqsRankeadas) => {
  if (!policyGanadora) return [];
  return faqsRankeadas.filter((faq) => {
    const estaVinculada = (faq.linkedPolicyIds || []).some((id) => id.toString() === policyGanadora._id.toString());
    return !estaVinculada && faq.category === policyGanadora.category;
  });
};

/**
 * Punto único de resolución para la tool de la IA (Etapa 6): retoma los
 * candidatos hard-filtrados de buscarConocimiento() y aplica precedencia
 * (§10), detecta ambigüedad por producto (TC-08) y conflicto Policy/FAQ
 * (TC-10). Forma de retorno alineada al `KnowledgeSearchResult` conceptual
 * del documento §12 (policies/faqs ya rankeados, conflictDetected,
 * needsClarification, traceId para auditoría — documento §19).
 *
 * El `KnowledgeUsageEvent` completo del documento §19 (con
 * conversationId/leadId) se registra en la Etapa 6, que es quien tiene
 * ese contexto — acá solo se loguea el conflicto estructural en sí
 * (decisión confirmada: logger.info() para V1, sin colección dedicada),
 * porque es una señal útil para revisión humana incluso fuera de una
 * conversación puntual.
 *
 * @param {string} businessId
 * @param {string} [texto]
 * @param {{ productIds?: string[], channelId?: string }} [contexto]
 */
const resolverConocimiento = async (businessId, texto, contexto = {}) => {
  const traceId = `kb_${new mongoose.Types.ObjectId().toHexString()}`;
  const [{ policies, faqs }, documentChunksCrudos] = await Promise.all([
    buscarConocimiento(businessId, texto, contexto),
    // Bloque 3 (§45-51, 20/sep/2026) — RAG del PDF, mismo punto único de
    // resolución que Policy/FAQ.
    buscarChunksDocumento(businessId, texto),
  ]);

  // Fase 2, punto 5 (§52/§54, 20/sep/2026) — barrera de código, no de
  // prompt: un chunk del PDF que menciona precio/stock de un producto que
  // SÍ existe en el catálogo estructurado se descarta acá, ANTES de que
  // el resultado llegue a la tool/al modelo. Nunca al revés (Policy/FAQ
  // no pasan por este filtro, ver priceStockGuard.service.js).
  const documentChunks = await descartarClaimsDePrecioStockDesactualizados(documentChunksCrudos, businessId);

  const policiesRankeadas = rankearPolicies(policies);
  const faqsRankeadas = rankearFAQs(faqs, policiesRankeadas);

  const sinContextoDeProducto = !contexto.productIds?.length;
  const policiesGenerales = policiesRankeadas.filter((p) => p.scope?.appliesToAll !== false);
  const needsClarification = sinContextoDeProducto
    ? await detectarAmbiguedadPorProducto(businessId, texto, policiesGenerales)
    : false;

  const policyGanadora = !needsClarification ? policiesRankeadas[0] || null : null;
  const faqsEnConflicto = detectarConflictoConFAQIndependiente(policyGanadora, faqsRankeadas);
  const conflictDetected = faqsEnConflicto.length > 0;

  if (conflictDetected) {
    logger.info(
      `BUSINESS_KNOWLEDGE_CONFLICT: business=${businessId} traceId=${traceId} category=${policyGanadora.category} policyId=${policyGanadora._id} faqIds=${faqsEnConflicto.map((f) => f._id).join(',')}`
    );
  }

  return {
    policies: policiesRankeadas,
    faqs: faqsRankeadas,
    // Orden por similitud (ya viene ordenado de buscarSemantico/Atlas) —
    // sin precedencia propia todavía, a diferencia de policies/faqs (acá
    // no hay un concepto de "prioridad" declarada por el dueño del
    // negocio, solo relevancia semántica).
    documentChunks: documentChunks.map((c) => ({ text: c.text, page: c.page, score: c.score })),
    conflictDetected,
    needsClarification,
    traceId,
  };
};

module.exports = {
  buscarConocimiento,
  buscarChunksDocumento,
  resolverConocimiento,
};
