const Policy = require('./policy.model');
const FAQ = require('./faq.model');

// CREA SALES AI™ — C.2 Business Brain: Policies + FAQ V1. Etapa 3/11
// (retrieval con hard filters — SIN precedencia/ranking/detección de
// conflicto todavía, eso es la Etapa 4). Este archivo es el ÚNICO punto
// de retrieval que va a consumir la tool de la IA (Etapa 6) — nunca
// policy.service.js/faq.service.js directamente, que son CRUD de
// administración sin garantía de vigencia/estado.
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

  const queryPolicy = { ...filtroElegible, $or: scopeOrPolicy };
  const queryFAQ = { ...filtroElegible, $or: scopeOrFAQ };

  const hayTexto = Boolean(texto && texto.trim());
  if (hayTexto) {
    queryPolicy.$text = { $search: texto };
    queryFAQ.$text = { $search: texto };
  }

  const proyeccion = hayTexto ? { score: { $meta: 'textScore' } } : {};
  const orden = hayTexto ? { score: { $meta: 'textScore' } } : { priority: -1 };

  const [policies, faqs] = await Promise.all([
    Policy.find(queryPolicy, proyeccion).sort(orden).limit(LIMITE_CANDIDATOS).lean(),
    FAQ.find(queryFAQ, proyeccion).sort(orden).limit(LIMITE_CANDIDATOS).lean(),
  ]);

  return { policies, faqs };
};

module.exports = {
  buscarConocimiento,
};
