const { generarUrlDeAcceso } = require('../../utils/cloudinaryAssetAccess');

/**
 * Bloque 2 de la auditoría Business Brain (§37-39, 20/sep/2026) — genera
 * URLs de acceso firmadas para fotos de Product.mediaAssets, mismo
 * mecanismo real que businessAssetAccess.service.js (Bloque 1), pero SIN
 * su fallback dual-mode: los mediaAssets de producto son 100% nuevos, nacen
 * directo type:'authenticated' en Cloudinary — nunca hay una URL pública
 * vieja que resolver acá (a diferencia de logo/photos/etc. de Business, que
 * sí convivieron con datos preexistentes).
 */

/**
 * Resuelve la foto PRINCIPAL de un producto: la marcada isPrimary:true, o
 * la primera del array si ninguna está marcada (ej. un producto con una
 * sola foto, donde marcarla explícitamente sería redundante). null si el
 * producto no tiene ninguna foto cargada.
 */
const resolverFotoPrincipal = (product) => {
  const assets = product?.mediaAssets || [];
  if (!assets.length) return null;

  const principal = assets.find((m) => m.isPrimary) || assets[0];
  return { publicId: principal.publicId, resourceType: principal.resourceType, tipoEntrega: 'authenticated', caption: principal.caption || null };
};

/** Resuelve UNA foto puntual por su _id — para borrar/ver una individual desde el dashboard. */
const resolverFotoPorId = (product, mediaId) => {
  const asset = (product?.mediaAssets || []).find((m) => String(m._id) === String(mediaId));
  if (!asset) return null;
  return { publicId: asset.publicId, resourceType: asset.resourceType, tipoEntrega: 'authenticated', caption: asset.caption || null };
};

/** Todas las fotos del producto, en orden de galería (campo `order`) — para una futura vista de galería completa en el dashboard. */
const resolverFotos = (product) => {
  const assets = product?.mediaAssets || [];
  return [...assets]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((m) => ({ mediaId: m._id, publicId: m.publicId, resourceType: m.resourceType, tipoEntrega: 'authenticated', caption: m.caption || null, isPrimary: !!m.isPrimary }));
};

const obtenerUrlDeAccesoFotoPrincipal = (product, proposito = 'display') =>
  generarUrlDeAcceso(resolverFotoPrincipal(product), proposito);

const obtenerUrlDeAccesoFotoPorId = (product, mediaId, proposito = 'display') =>
  generarUrlDeAcceso(resolverFotoPorId(product, mediaId), proposito);

module.exports = {
  resolverFotoPrincipal,
  resolverFotoPorId,
  resolverFotos,
  obtenerUrlDeAccesoFotoPrincipal,
  obtenerUrlDeAccesoFotoPorId,
};
