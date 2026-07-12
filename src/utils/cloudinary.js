const cloudinary = require('cloudinary').v2;
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = require('../config/env');

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

/**
 * Sube un buffer en memoria a Cloudinary (evita escribir a disco).
 */
const subirBuffer = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    stream.end(buffer);
  });
};

/**
 * Extrae el public_id y resource_type de una URL de Cloudinary
 * (ej: https://res.cloudinary.com/<cloud>/image/upload/v123/carpeta/archivo.png).
 */
const extraerPublicId = (url) => {
  const match = url.match(/\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
  if (!match) return null;

  const [, resourceType, publicId] = match;
  return { resourceType, publicId };
};

/**
 * Borra un asset de Cloudinary a partir de su URL guardada en la BD.
 * No lanza error si falla — es limpieza best-effort, no debe bloquear
 * el flujo principal (ej. subir un nuevo logo aunque falle borrar el viejo).
 */
const eliminarPorUrl = async (url, logger) => {
  if (!url) return;

  const datos = extraerPublicId(url);
  if (!datos) {
    logger?.warn(`No se pudo extraer public_id de la URL de Cloudinary: ${url}`);
    return;
  }

  try {
    await cloudinary.uploader.destroy(datos.publicId, { resource_type: datos.resourceType });
  } catch (error) {
    logger?.warn(`Error al borrar asset de Cloudinary (${datos.publicId}): ${error.message}`);
  }
};

module.exports = { cloudinary, subirBuffer, extraerPublicId, eliminarPorUrl };
