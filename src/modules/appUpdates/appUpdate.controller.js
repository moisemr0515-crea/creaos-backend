const service = require('./appUpdate.service');
const { validateBody } = require('../../shared/utils/validate');
const { checkUpdateSchema, publishBundleSchema } = require('./appUpdate.validator');
const { respuestaExito } = require('../../utils/response');
const { AppError } = require('../../shared/utils/AppError');

// POST /api/v1/app-updates/check — SIN envolver en el sobre {success,
// data} habitual del resto de la API: este es un contrato externo fijo
// (el que espera capacitor-updater, ver AppInfos/UpdateResponse en su
// documentación), no una respuesta interna nuestra. Devolver {} es la
// forma en que el plugin entiende "no hay update".
const check = async (req, res, next) => {
  try {
    const { platform, version_name: versionActual, channel } = await validateBody(checkUpdateSchema, req.body);
    const bundle = await service.buscarActualizacion({ platform, channel, versionActual });
    if (!bundle) return res.status(200).json({});

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return res.status(200).json({
      version: bundle.version,
      url: `${baseUrl}/api/v1/app-updates/download/${bundle.filename}`,
      checksum: bundle.checksumSha256,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/app-updates/publish — SuperAdmin únicamente (ver
// appUpdate.routes.js). req.file lo deja multer (memoryStorage, ver
// routes) tras pasar por traducirErroresDeMulter().
const publish = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Falta el archivo del bundle (.zip)', 400);
    if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
      throw new AppError('El bundle debe ser un archivo .zip', 400);
    }

    const { platform, version, channel } = await validateBody(publishBundleSchema, req.body);
    const bundle = await service.publicarBundle({
      platform,
      channel,
      version,
      buffer: req.file.buffer,
      publishedBy: req.user._id,
    });

    return respuestaExito(res, {
      statusCode: 201,
      message: 'Bundle publicado exitosamente',
      data: {
        bundle: {
          id: bundle._id,
          platform: bundle.platform,
          channel: bundle.channel,
          version: bundle.version,
          checksumSha256: bundle.checksumSha256,
          sizeBytes: bundle.sizeBytes,
          createdAt: bundle.createdAt,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/app-updates/download/:filename — público a propósito (mismo
// criterio que cualquier CDN de assets estáticos: el .zip en sí no es
// secreto, es el código de la app). :filename SIEMPRE se resuelve contra
// Mongo antes de tocar el filesystem — ver
// appUpdate.service.js#buscarBundlePorFilename().
const download = async (req, res, next) => {
  try {
    const bundle = await service.buscarBundlePorFilename(req.params.filename);
    if (!bundle) throw new AppError('Bundle no encontrado', 404);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename}"`);

    const stream = service.streamDeBundle(bundle.filename);
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
};

module.exports = { check, publish, download };
