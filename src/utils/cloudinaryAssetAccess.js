const { cloudinary } = require('./cloudinary');

/**
 * Núcleo genérico de generación de URLs de acceso firmadas — extraído de
 * businessAssetAccess.service.js (P0 de seguridad, Bloque 1, 19/sep/2026)
 * al construir productAssetAccess.service.js (Bloque 2, 20/sep/2026): la
 * lógica de firma (`private_download_url()` + TTL por propósito) no tiene
 * nada de "business" — es igual de válida para un asset de negocio que
 * para una foto de producto. Ambos services consumen esto tal cual, cada
 * uno con su propia forma de RESOLVER {publicId, resourceType, tipoEntrega}
 * (esa parte sí es específica de cada dominio, no se comparte).
 *
 * Mecanismo: cloudinary.utils.private_download_url() con expires_at — NO
 * cloudinary auth_token (función Premium, no disponible en el plan Free de
 * esta cuenta, confirmado con cloudinary.api.usage()). Verificado
 * empíricamente que NO agrega Content-Disposition:attachment — sirve igual
 * para <img>/<video> inline que para links de descarga.
 */
const DURACION_SEGUNDOS = {
  // 15 min — el dashboard vuelve a pedir la URL cada vez que se abre/
  // refresca la sección, no hay necesidad de que dure más.
  display: 15 * 60,
  // 48h — cubre cualquier demora real de Meta/Gupshup en buscar el
  // archivo, sin depender de que lo hagan de inmediato.
  send: 48 * 60 * 60,
};

// resourceType -> extensión para private_download_url() (pide el "format"
// aparte del public_id). Alcanza con estos 3 — son los únicos resourceType
// que usan los consumidores de hoy (logo/fotos: image, video: video,
// pdf/brochure: raw).
const EXTENSION_POR_TIPO = { image: 'jpg', video: 'mp4', raw: 'pdf' };

/**
 * Genera la URL de acceso real para un asset ya resuelto. Firmada y con
 * expiración real si es type:'authenticated'. Cualquier otro delivery
 * falla cerrado: nunca reconstruye ni entrega una URL pública permanente.
 */
const generarUrlDeAcceso = (datos, proposito = 'display') => {
  if (!datos) return null;
  if (datos.tipoEntrega !== 'authenticated') {
    return null;
  }
  const duracion = DURACION_SEGUNDOS[proposito] ?? DURACION_SEGUNDOS.display;
  return cloudinary.utils.private_download_url(
    datos.publicId,
    datos.format || EXTENSION_POR_TIPO[datos.resourceType] || 'jpg',
    {
      resource_type: datos.resourceType,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + duracion,
    }
  );
};

module.exports = { DURACION_SEGUNDOS, EXTENSION_POR_TIPO, generarUrlDeAcceso };
