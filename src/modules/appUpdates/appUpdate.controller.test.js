jest.mock('./appUpdate.service');

const mongoose = require('mongoose');
const service = require('./appUpdate.service');
const { check, publish, download } = require('./appUpdate.controller');

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res;
};

describe('appUpdate.controller', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('check()', () => {
    test('sin update disponible: responde {} SIN el sobre {success,data} habitual', async () => {
      service.buscarActualizacion.mockResolvedValue(null);
      const req = { body: { platform: 'android', version_name: 'builtin', channel: 'production' }, protocol: 'https', get: () => 'creaos-backend-production.up.railway.app' };
      const res = response();

      await check(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({});
    });

    test('con update disponible: responde exactamente {version, url, checksum} (contrato del plugin)', async () => {
      service.buscarActualizacion.mockResolvedValue({
        version: '1.2.0',
        filename: 'android-production-1.2.0-123-abcd.zip',
        checksumSha256: 'a'.repeat(64),
      });
      const req = {
        body: { platform: 'android', version_name: 'builtin', channel: 'production' },
        protocol: 'https',
        get: () => 'creaos-backend-production.up.railway.app',
      };
      const res = response();

      await check(req, res, jest.fn());

      expect(res.json).toHaveBeenCalledWith({
        version: '1.2.0',
        url: 'https://creaos-backend-production.up.railway.app/api/v1/app-updates/download/android-production-1.2.0-123-abcd.zip',
        checksum: 'a'.repeat(64),
      });
    });

    test('platform inválido → 400 vía next(AppError), no revienta con 500', async () => {
      const req = { body: { platform: 'windows' }, protocol: 'https', get: () => 'x' };
      const next = jest.fn();

      await check(req, response(), next);

      expect(service.buscarActualizacion).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('publish()', () => {
    const publishedBy = new mongoose.Types.ObjectId().toString();

    test('sin archivo adjunto → 400 vía next(AppError), no llama al servicio', async () => {
      const req = { body: { platform: 'android', version: '1.0.0' }, user: { _id: publishedBy }, file: undefined };
      const next = jest.fn();

      await publish(req, response(), next);

      expect(service.publicarBundle).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('archivo que no es .zip → 400, no llama al servicio', async () => {
      const req = {
        body: { platform: 'android', version: '1.0.0' },
        user: { _id: publishedBy },
        file: { originalname: 'bundle.tar.gz', buffer: Buffer.from('x') },
      };
      const next = jest.fn();

      await publish(req, response(), next);

      expect(service.publicarBundle).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    test('publicación válida: delega en el servicio con publishedBy = req.user._id', async () => {
      service.publicarBundle.mockResolvedValue({
        _id: 'bundle-1', platform: 'android', channel: 'production', version: '1.0.0',
        checksumSha256: 'a'.repeat(64), sizeBytes: 10, createdAt: new Date(),
      });
      const buffer = Buffer.from('contenido');
      const req = {
        body: { platform: 'android', version: '1.0.0', channel: 'production' },
        user: { _id: publishedBy },
        file: { originalname: 'bundle.zip', buffer },
      };
      const res = response();

      await publish(req, res, jest.fn());

      expect(service.publicarBundle).toHaveBeenCalledWith({
        platform: 'android', channel: 'production', version: '1.0.0', buffer, publishedBy,
      });
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('download()', () => {
    test('filename desconocido (no publicado) → 404, nunca intenta abrir el filesystem', async () => {
      service.buscarBundlePorFilename.mockResolvedValue(null);
      const req = { params: { filename: '../../etc/passwd' } };
      const next = jest.fn();

      await download(req, response(), next);

      expect(service.streamDeBundle).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    test('filename real: arma headers y hace pipe del stream', async () => {
      service.buscarBundlePorFilename.mockResolvedValue({ filename: 'android-production-1.0.0-1-aaaa.zip' });
      const stream = { on: jest.fn().mockReturnThis(), pipe: jest.fn() };
      service.streamDeBundle.mockReturnValue(stream);
      const req = { params: { filename: 'android-production-1.0.0-1-aaaa.zip' } };
      const res = response();

      await download(req, res, jest.fn());

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/zip');
      expect(stream.pipe).toHaveBeenCalledWith(res);
    });
  });
});
