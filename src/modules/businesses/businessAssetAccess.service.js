const { extraerPublicId } = require('../../utils/cloudinary');
const { DURACION_SEGUNDOS, generarUrlDeAcceso } = require('../../utils/cloudinaryAssetAccess');

/**
 * P0 de seguridad (auditoría Business Brain, 19/sep/2026, Bloque 1) —
 * genera URLs de acceso a assets de negocio con expiración real, en vez de
 * la URL pública permanente de Cloudinary que existe hoy (ver diagnóstico
 * en docs/business-brain-audit/).
 *
 * El núcleo de firma (DURACION_SEGUNDOS/generarUrlDeAcceso) vive en
 * src/utils/cloudinaryAssetAccess.js desde el Bloque 2 (20/sep/2026,
 * extraído al construir productAssetAccess.service.js) — es 100% genérico,
 * no tiene nada de "business". Este archivo se queda con lo que SÍ es
 * específico de negocio: RESOLVER {publicId, resourceType, tipoEntrega} a
 * partir de un documento Business (dual-mode: campo *Asset nuevo vs. URL
 * vieja, ver resolverAsset()/resolverFoto() abajo).
 *
 * TTL variable por PROPÓSITO, no un valor único — decisión confirmada
 * después de identificar 2 restricciones reales:
 * - 'display' (dashboard, <img>/<video>, re-descarga en savePhotos()):
 *   corta, se vuelve a pedir fresca cada vez que hace falta.
 * - 'send' (send_media -> channelService.sendMedia() -> Gupshup -> Meta):
 *   larga — Meta busca el archivo de forma ASÍNCRONA, una URL de minutos
 *   podría expirar antes de que la procesen.
 */

// Campo *Asset (forma nueva) -> función que lee la URL vieja equivalente,
// para el fallback dual-mode mientras el Paso 3 (migración de datos)
// todavía no corrió sobre un documento puntual.
const CAMPO_URL_LEGACY = {
  logo: (business) => business.logo,
  pdf: (business) => business.pdfUrl,
  presentationVideo: (business) => business.presentationVideoUrl,
  brochure: (business) => business.brochureUrl,
};

/**
 * Resuelve {publicId, resourceType, tipoEntrega} para un campo de asset —
 * prioriza la forma NUEVA (business.<campo>Asset) y cae a extraer el
 * public_id de la URL vieja si el documento todavía no se migró (Paso 1/2:
 * ambas formas coexisten). tipoEntrega:'authenticated' en la forma nueva
 * (siempre, después del Paso 3); 'upload' en el fallback — todavía público
 * en Cloudinary, no hay nada real que firmar todavía.
 */
const resolverAsset = (business, campo) => {
  const assetField = business[`${campo}Asset`];
  if (assetField?.publicId) {
    return { publicId: assetField.publicId, resourceType: assetField.resourceType, tipoEntrega: 'authenticated' };
  }
  const urlVieja = CAMPO_URL_LEGACY[campo]?.(business);
  if (!urlVieja) return null;
  const datos = extraerPublicId(urlVieja);
  if (!datos) return null;
  return { publicId: datos.publicId, resourceType: datos.resourceType, tipoEntrega: 'upload' };
};

/** Fotos: array, necesita índice — mismo criterio dual-mode que resolverAsset(). */
const resolverFoto = (business, index) => {
  const asset = business.photoAssets?.[index];
  if (asset?.publicId) {
    return { publicId: asset.publicId, resourceType: asset.resourceType, tipoEntrega: 'authenticated' };
  }
  const urlVieja = business.photos?.[index];
  if (!urlVieja) return null;
  const datos = extraerPublicId(urlVieja);
  if (!datos) return null;
  return { publicId: datos.publicId, resourceType: datos.resourceType, tipoEntrega: 'upload' };
};

const obtenerUrlDeAcceso = (business, campo, proposito = 'display') =>
  generarUrlDeAcceso(resolverAsset(business, campo), proposito);

const obtenerUrlDeAccesoFoto = (business, index, proposito = 'display') =>
  generarUrlDeAcceso(resolverFoto(business, index), proposito);

module.exports = {
  DURACION_SEGUNDOS,
  resolverAsset,
  resolverFoto,
  generarUrlDeAcceso,
  obtenerUrlDeAcceso,
  obtenerUrlDeAccesoFoto,
};
