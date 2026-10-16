/**
 * REGISTRO ÚNICO de lo que alimenta a la IA desde la pantalla «Mi negocio» (Fase 3, etapa C — contrato anti-rotura).
 *
 * Dos familias, con reglas opuestas:
 *   LEE   — la IA APRENDE de esto para responder. NUNCA se envía al lead.
 *           (Instrucciones de la IA, PDF informativo, Inventario y catálogo, Políticas, Preguntas frecuentes)
 *   ENVIA — la IA lo MANDA por WhatsApp cuando el lead lo pide.
 *           (logo, fotos de producto del negocio, video de presentación, brochure)
 *
 * Cada entrada declara: sección de la pantalla, colección/campo de origen, quién la consume en el camino del agente
 * (prompt o herramienta) y sus límites. Quien agregue una sección a la pantalla o un campo de asset al modelo SIN
 * registrarla rompe `businessAssets.registry.contract.test.js` (estático + de comportamiento). No hay lógica por tipo
 * fuera de este archivo: `resolverEnviable` es el único punto que convierte un recurso en `{url,type,filename?}`.
 */
const businessAssetAccess = require('./businessAssetAccess.service');

const MB = 1024 * 1024;

// Límites de WhatsApp (Meta) para media saliente — el tope real de cada tipo.
const LIMITES_WHATSAPP = Object.freeze({ image: 5 * MB, video: 16 * MB, document: 100 * MB });

const texto = (v) => (typeof v === 'string' ? v.trim() : '');

// ── ENVIA ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const ENVIA = Object.freeze([
  {
    key: 'logo',
    section: 'Material que tu IA puede enviar',
    label: 'logo',
    resource: 'logo',
    mediaType: 'image',
    origin: { collection: 'businesses', fields: ['logo', 'logoAsset'] },
    consumer: { kind: 'tool', name: 'send_media', resource: 'logo' },
    limits: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * MB },
    url: (business, proposito) => businessAssetAccess.obtenerUrlDeAcceso(business, 'logo', proposito),
    resolveAsset: (business) => businessAssetAccess.resolverAsset(business, 'logo'),
    declared: (business) => Boolean(texto(business.logo) || business.logoAsset?.publicId),
  },
  {
    key: 'businessPhotos',
    section: 'Material que tu IA puede enviar',
    label: 'foto del negocio',
    resource: 'business_photos',
    mediaType: 'image',
    multiple: 2, // «Fotos de producto (1-2)» de la pantalla
    origin: { collection: 'businesses', fields: ['photos', 'photoAssets'] },
    consumer: { kind: 'tool', name: 'send_media', resource: 'business_photos' },
    limits: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * MB, maxItems: 2 },
    url: (business, proposito, index) => businessAssetAccess.obtenerUrlDeAccesoFoto(business, index, proposito),
    resolveAsset: (business, index) => businessAssetAccess.resolverFoto(business, index),
    declared: (business, index) => Boolean(texto(business.photos?.[index]) || business.photoAssets?.[index]?.publicId),
    count: (business) => Math.max(business.photos?.length || 0, business.photoAssets?.length || 0),
  },
  {
    key: 'presentationVideo',
    section: 'Material que tu IA puede enviar',
    label: 'video de presentación',
    resource: 'presentation_video',
    mediaType: 'video',
    origin: { collection: 'businesses', fields: ['presentationVideoUrl', 'presentationVideoAsset'] },
    consumer: { kind: 'tool', name: 'send_media', resource: 'presentation_video' },
    limits: { mimeTypes: ['video/mp4', 'video/3gpp'], maxBytes: 16 * MB },
    url: (business, proposito) => businessAssetAccess.obtenerUrlDeAcceso(business, 'presentationVideo', proposito),
    resolveAsset: (business) => businessAssetAccess.resolverAsset(business, 'presentationVideo'),
    declared: (business) => Boolean(texto(business.presentationVideoUrl) || business.presentationVideoAsset?.publicId),
  },
  {
    key: 'brochure',
    section: 'Material que tu IA puede enviar',
    label: 'brochure',
    resource: 'brochure',
    mediaType: 'document',
    origin: { collection: 'businesses', fields: ['brochureUrl', 'brochureFilename', 'brochureAsset'] },
    consumer: { kind: 'tool', name: 'send_media', resource: 'brochure' },
    limits: { mimeTypes: ['application/pdf'], maxBytes: 100 * MB },
    url: (business, proposito) => businessAssetAccess.obtenerUrlDeAcceso(business, 'brochure', proposito),
    resolveAsset: (business) => businessAssetAccess.resolverAsset(business, 'brochure'),
    declared: (business) => Boolean(texto(business.brochureUrl) || business.brochureAsset?.publicId || business.brochureAsset?.storageKey),
    filename: (business) => texto(business.brochureFilename) || undefined,
  },
]);

// Fotos de cada producto del catálogo: las envía `send_product_photos` (por producto), no `send_media`; por eso no tienen
// `resource`. Siguen en el registro para que ningún campo que la IA envía quede fuera del contrato.
const ENVIA_DE_PRODUCTO = Object.freeze({
  key: 'productPhotos',
  section: 'Inventario y catálogo',
  label: 'fotos de producto del catálogo',
  resource: null,
  mediaType: 'image',
  productScoped: true,
  origin: { collection: 'products', fields: ['mediaAssets'] },
  consumer: { kind: 'tool', name: 'send_product_photos' },
  limits: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * MB, maxItems: 8 },
});

const ENVIA_POR_RESOURCE = Object.freeze(Object.fromEntries(ENVIA.map((e) => [e.resource, e])));
const RESOURCES_ENVIABLES = Object.freeze(ENVIA.map((e) => e.resource));

/**
 * ÚNICO punto que convierte un recurso enviable en el `media` que viaja al OutboundEvent y a Gupshup.
 * @returns {{unknown:true} | {entry, missing:true} | {entry, media:{url,type,filename?}, mediaKey:string}}
 */
const resolverEnviable = async (business, resource, { photo } = {}) => {
  const entry = ENVIA_POR_RESOURCE[resource];
  if (!entry) return { unknown: true };

  let index = 0;
  if (entry.multiple) {
    const n = Number.isInteger(photo) ? photo : 1;
    index = Math.min(Math.max(n, 1), entry.multiple) - 1;
  }

  const url = await entry.url(business, 'send', index);
  if (!url) return { entry, missing: true, index };

  const filename = entry.filename ? entry.filename(business) : undefined;
  const media = { url, type: entry.mediaType, ...(filename ? { filename } : {}) };
  return { entry, media, index, mediaKey: entry.multiple ? `business:photo:${index + 1}` : `business:${entry.resource}` };
};

// ── LEE ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// `promptMarker`/`tools`: dónde lo consume el agente. El test de contrato comprueba que existen de verdad.
const LEE = Object.freeze([
  {
    key: 'aiInstructions',
    section: 'Instrucciones para tu IA',
    label: 'instrucciones de la IA',
    origin: { collection: 'businesses', fields: ['aiInstructions', 'aiPersonality'] },
    consumers: [{ kind: 'prompt', name: 'buildSystemPrompt', marker: 'INSTRUCCIONES ESPECÍFICAS DEL DUEÑO' }],
    limits: { kind: 'text' },
  },
  {
    key: 'infoPdf',
    section: 'Base de conocimiento de tu IA',
    label: 'PDF informativo',
    origin: { collection: 'businesses', fields: ['pdfUrl', 'pdfAsset', 'pdfExtractedText', 'pdfSummary'], related: ['businessdocuments', 'businessdocumentchunks'] },
    consumers: [
      { kind: 'prompt', name: 'buildSystemPrompt', marker: 'Información adicional del negocio (de su documento)' },
      { kind: 'tool', name: 'search_business_knowledge' },
      { kind: 'tool', name: 'search_products', via: 'documentFallback' },
    ],
    limits: { kind: 'file', mimeTypes: ['application/pdf'], maxBytes: 10 * MB, neverSent: true },
  },
  {
    key: 'catalog',
    section: 'Inventario y catálogo',
    label: 'inventario y catálogo',
    origin: { collection: 'products', fields: ['name', 'description', 'price', 'physicalStock', 'keywords', 'synonyms', 'active'] },
    consumers: [{ kind: 'tool', name: 'search_products' }, { kind: 'tool', name: 'check_stock' }, { kind: 'tool', name: 'get_price' }],
    limits: { kind: 'records', maxSearchResults: 5 },
  },
  {
    key: 'policies',
    section: 'Políticas',
    label: 'políticas',
    origin: { collection: 'policies', fields: ['title', 'statement', 'customerFacingText', 'status'] },
    consumers: [{ kind: 'tool', name: 'search_business_knowledge' }],
    limits: { kind: 'records', onlyStatus: 'active' },
  },
  {
    key: 'faqs',
    section: 'Preguntas frecuentes',
    label: 'preguntas frecuentes',
    origin: { collection: 'faqs', fields: ['question', 'answer', 'status'] },
    consumers: [{ kind: 'tool', name: 'search_business_knowledge' }],
    limits: { kind: 'records', onlyStatus: 'active' },
  },
]);

// Campos del modelo `Business` que alimentan a la IA y su entrada. El test estático exige que todo campo de asset/
// conocimiento del modelo esté acá o en NO_ALIMENTAN_A_LA_IA (con motivo).
const CAMPOS_DE_BUSINESS = Object.freeze({
  ...Object.fromEntries(ENVIA.flatMap((e) => e.origin.fields.map((f) => [f, { family: 'ENVIA', key: e.key }]))),
  ...Object.fromEntries(LEE.filter((e) => e.origin.collection === 'businesses').flatMap((e) => e.origin.fields.map((f) => [f, { family: 'LEE', key: e.key }]))),
});

// Campos de `Business` relacionados con archivos o conocimiento que a propósito NO son una sección de la IA.
const NO_ALIMENTAN_A_LA_IA = Object.freeze({
  pdfUploadedAt: 'fecha de subida del PDF (metadato)',
});

module.exports = {
  LEE,
  ENVIA,
  ENVIA_DE_PRODUCTO,
  ENVIA_POR_RESOURCE,
  RESOURCES_ENVIABLES,
  CAMPOS_DE_BUSINESS,
  NO_ALIMENTAN_A_LA_IA,
  LIMITES_WHATSAPP,
  resolverEnviable,
};
