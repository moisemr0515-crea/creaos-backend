const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const AppBundle = require('./appUpdate.model');
const { APP_UPDATES_DIR } = require('../../config/env');
const { AppError } = require('../../shared/utils/AppError');

const directorioBundles = () => path.resolve(APP_UPDATES_DIR);

// El nombre de archivo en disco NUNCA sale directo de un valor que mande
// el cliente (ni siquiera el `version`/`channel` ya validados por Joi en
// la ruta de publish) — se sanitiza de nuevo acá, en la única función que
// arma paths reales, como defensa en profundidad contra path traversal.
const sanitizarSegmento = (valor) =>
  String(valor)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    // ".." sigue siendo peligroso aunque "." solo esté permitido (hace
    // falta para versiones tipo "1.0.0") — se colapsa cualquier corrida de
    // 2+ puntos en un solo "_" para que nunca sobreviva un segmento "..".
    .replace(/\.{2,}/g, '_');

const nombrarArchivo = ({ platform, channel, version }) => {
  const sufijo = crypto.randomBytes(4).toString('hex');
  return `${sanitizarSegmento(platform)}-${sanitizarSegmento(channel)}-${sanitizarSegmento(version)}-${Date.now()}-${sufijo}.zip`;
};

/**
 * Guarda un bundle nuevo en APP_UPDATES_DIR (Railway Volume montado ahí en
 * producción) y lo registra como el bundle ACTIVO para {platform, channel},
 * desactivando (soft) el que estuviera activo antes — buscarActualizacion()
 * nunca tiene que elegir entre dos bundles activos a la vez.
 *
 * No hay verificación criptográfica de firma acá a propósito (ver
 * diagnóstico de política de Google Play / capacitor-updater): el plugin
 * self-hosted solo verifica un checksum SHA256 contra corrupción, no
 * contra un actor malicioso — la defensa real es que esta función solo se
 * alcanza detrás de checkRole(SUPER_ADMIN) en la ruta (ver
 * appUpdate.routes.js), nunca un endpoint público.
 */
const publicarBundle = async ({ platform, channel, version, buffer, publishedBy }) => {
  const dir = directorioBundles();
  await fsp.mkdir(dir, { recursive: true });

  const filename = nombrarArchivo({ platform, channel, version });
  const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  await fsp.writeFile(path.join(dir, filename), buffer);

  await AppBundle.updateMany(
    { platform, channel, isActive: true },
    { $set: { isActive: false } }
  );

  return AppBundle.create({
    platform,
    channel,
    version,
    filename,
    checksumSha256,
    sizeBytes: buffer.length,
    isActive: true,
    publishedBy,
  });
};

/**
 * Devuelve el bundle activo de {platform, channel} si es distinto del que
 * ya tiene instalado el cliente (versionActual, "builtin" si nunca aplicó
 * ningún update) — o null si no hay nada nuevo para ofrecer.
 *
 * Comparación por igualdad de string, no por orden semántico: el bundle
 * activo es siempre el más reciente publicado (publicarBundle() desactiva
 * el anterior), así que "distinto de lo que ya tiene" alcanza. No hace
 * falta que el cliente pueda "bajar" de versión por esta vía.
 */
const buscarActualizacion = async ({ platform, channel, versionActual }) => {
  const bundle = await AppBundle.findOne({ platform, channel, isActive: true }).sort({ createdAt: -1 });
  if (!bundle) return null;
  if (bundle.version === versionActual) return null;
  return bundle;
};

/**
 * Resuelve un filename a su registro en Mongo — la descarga (GET
 * /app-updates/download/:filename) nunca arma un path a partir del
 * :filename crudo sin pasar antes por acá: si no hay un AppBundle con ese
 * nombre exacto, no existe ningún archivo que mostrar, sin importar qué
 * exista de verdad en el filesystem.
 */
const buscarBundlePorFilename = async (filename) => {
  return AppBundle.findOne({ filename });
};

const streamDeBundle = (filename) => {
  const dir = directorioBundles();
  const rutaArchivo = path.resolve(dir, filename);
  // Comparación con separador de por medio (no un startsWith(dir) a
  // secas) — un startsWith simple deja pasar un directorio hermano tipo
  // "<dir>-evil/..." que arranca con el mismo prefijo de texto sin estar
  // realmente adentro de `dir`. No debería poder pasar nunca (filename ya
  // viene de un documento propio, nunca de texto crudo del cliente) —
  // chequeo defensivo, no una ruta esperada.
  if (rutaArchivo !== dir && !rutaArchivo.startsWith(dir + path.sep)) {
    throw new AppError('Archivo inválido', 400);
  }
  return fs.createReadStream(rutaArchivo);
};

module.exports = { publicarBundle, buscarActualizacion, buscarBundlePorFilename, streamDeBundle };
