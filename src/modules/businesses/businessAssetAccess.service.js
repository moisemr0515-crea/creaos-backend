const { extraerPublicId } = require('../../utils/cloudinary');
const { DURACION_SEGUNDOS, generarUrlDeAcceso } = require('../../utils/cloudinaryAssetAccess');
const documentStorage = require('../../utils/documentStorage');
const { AppError } = require('../../middleware/error.middleware');

const CAMPO_URL_LEGACY = {
  logo: (business) => business.logo,
  pdf: (business) => business.pdfUrl,
  presentationVideo: (business) => business.presentationVideoUrl,
  brochure: (business) => business.brochureUrl,
};

const assertOwnership = (business, asset) => {
  if (!asset.businessId || String(asset.businessId) !== String(business._id)) {
    throw new AppError('El asset no pertenece a este negocio', 403);
  }
};

const resolverMetadataPrivada = (business, asset) => {
  if (!asset || asset.status !== 'active') return null;
  assertOwnership(business, asset);

  if (asset.provider === 'documentStorage' || asset.storageKey) {
    if (asset.deliveryType !== 'signed' || !asset.storageKey) return null;
    documentStorage.assertTenantKey(business._id, asset.storageKey);
    return {
      provider: 'documentStorage',
      storageKey: asset.storageKey,
      businessId: business._id,
    };
  }

  if (!asset.publicId || asset.deliveryType !== 'authenticated') return null;
  return {
    publicId: asset.publicId,
    resourceType: asset.resourceType,
    tipoEntrega: asset.deliveryType,
    ...(asset.format ? { format: asset.format } : {}),
  };
};

const resolverAsset = (business, campo) => {
  const assetField = business[`${campo}Asset`];
  if (assetField?.publicId || assetField?.storageKey) {
    return resolverMetadataPrivada(business, assetField);
  }
  const urlVieja = CAMPO_URL_LEGACY[campo]?.(business);
  if (!urlVieja) return null;
  const datos = extraerPublicId(urlVieja);
  if (!datos) return null;
  return { publicId: datos.publicId, resourceType: datos.resourceType, tipoEntrega: 'upload' };
};

const resolverFoto = (business, index) => {
  const asset = business.photoAssets?.[index];
  if (asset?.publicId) return resolverMetadataPrivada(business, asset);
  const urlVieja = business.photos?.[index];
  if (!urlVieja) return null;
  const datos = extraerPublicId(urlVieja);
  if (!datos) return null;
  return { publicId: datos.publicId, resourceType: datos.resourceType, tipoEntrega: 'upload' };
};

const generarAcceso = (datos, proposito) => {
  if (!datos) return null;
  if (datos.provider === 'documentStorage') {
    return documentStorage.createSignedAccessUrl({
      businessId: datos.businessId,
      storageKey: datos.storageKey,
      purpose: proposito,
    });
  }
  return generarUrlDeAcceso(datos, proposito);
};

const obtenerUrlDeAcceso = (business, campo, proposito = 'display') =>
  generarAcceso(resolverAsset(business, campo), proposito);

const obtenerUrlDeAccesoFoto = (business, index, proposito = 'display') =>
  generarAcceso(resolverFoto(business, index), proposito);

module.exports = {
  DURACION_SEGUNDOS,
  resolverAsset,
  resolverFoto,
  generarUrlDeAcceso,
  obtenerUrlDeAcceso,
  obtenerUrlDeAccesoFoto,
};
