// Test real (Jest, Mongo real + filesystem real en un dir temporal) del
// servicio de bundles OTA (capacitor-updater). APP_UPDATES_DIR se fija a un
// directorio temporal ANTES de requerir el servicio: config/env.js lee
// process.env en el momento del require, así que esto tiene que ir primero
// en el archivo.
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dirTemporal = fs.mkdtempSync(path.join(os.tmpdir(), 'creaos-test-app-updates-'));
process.env.APP_UPDATES_DIR = dirTemporal;

const mongoose = require('mongoose');
const AppBundle = require('./appUpdate.model');
const service = require('./appUpdate.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_app_updates';

describe('appUpdate.service', () => {
  const publishedBy = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await AppBundle.deleteMany({});
    await mongoose.disconnect();
    fs.rmSync(dirTemporal, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await AppBundle.deleteMany({});
  });

  describe('publicarBundle()', () => {
    test('escribe el .zip en APP_UPDATES_DIR y registra el checksum SHA256 real', async () => {
      const buffer = Buffer.from('contenido de prueba del bundle');
      const bundle = await service.publicarBundle({
        platform: 'android',
        channel: 'production',
        version: '1.2.0',
        buffer,
        publishedBy,
      });

      const checksumEsperado = crypto.createHash('sha256').update(buffer).digest('hex');
      expect(bundle.checksumSha256).toBe(checksumEsperado);
      expect(bundle.sizeBytes).toBe(buffer.length);
      expect(bundle.isActive).toBe(true);

      const contenidoEnDisco = fs.readFileSync(path.join(dirTemporal, bundle.filename));
      expect(contenidoEnDisco.equals(buffer)).toBe(true);
    });

    test('desactiva el bundle anterior del mismo {platform, channel} al publicar uno nuevo', async () => {
      const primero = await service.publicarBundle({
        platform: 'android', channel: 'production', version: '1.0.0',
        buffer: Buffer.from('v1'), publishedBy,
      });

      const segundo = await service.publicarBundle({
        platform: 'android', channel: 'production', version: '1.1.0',
        buffer: Buffer.from('v2'), publishedBy,
      });

      const primeroActualizado = await AppBundle.findById(primero._id);
      expect(primeroActualizado.isActive).toBe(false);
      expect(segundo.isActive).toBe(true);
    });

    test('NO desactiva bundles de otro channel o platform', async () => {
      const beta = await service.publicarBundle({
        platform: 'android', channel: 'beta', version: '1.0.0',
        buffer: Buffer.from('beta'), publishedBy,
      });

      await service.publicarBundle({
        platform: 'android', channel: 'production', version: '1.0.0',
        buffer: Buffer.from('prod'), publishedBy,
      });

      const betaActualizado = await AppBundle.findById(beta._id);
      expect(betaActualizado.isActive).toBe(true);
    });

    test('sanitiza platform/channel/version al armar el nombre del archivo (defensa contra path traversal)', async () => {
      const bundle = await service.publicarBundle({
        platform: 'android',
        channel: '../../etc',
        version: '1.0.0/../evil',
        buffer: Buffer.from('x'),
        publishedBy,
      });

      expect(bundle.filename).not.toMatch(/\.\./);
      expect(bundle.filename).not.toMatch(/\//);
      expect(fs.existsSync(path.join(dirTemporal, bundle.filename))).toBe(true);
    });
  });

  describe('buscarActualizacion()', () => {
    test('devuelve el bundle activo si la versión del cliente es distinta', async () => {
      await service.publicarBundle({
        platform: 'android', channel: 'production', version: '2.0.0',
        buffer: Buffer.from('v2'), publishedBy,
      });

      const resultado = await service.buscarActualizacion({
        platform: 'android', channel: 'production', versionActual: 'builtin',
      });

      expect(resultado).not.toBeNull();
      expect(resultado.version).toBe('2.0.0');
    });

    test('devuelve null si el cliente ya tiene la versión activa (nada que actualizar)', async () => {
      await service.publicarBundle({
        platform: 'android', channel: 'production', version: '2.0.0',
        buffer: Buffer.from('v2'), publishedBy,
      });

      const resultado = await service.buscarActualizacion({
        platform: 'android', channel: 'production', versionActual: '2.0.0',
      });

      expect(resultado).toBeNull();
    });

    test('devuelve null si no hay ningún bundle publicado para ese platform/channel', async () => {
      const resultado = await service.buscarActualizacion({
        platform: 'android', channel: 'production', versionActual: 'builtin',
      });

      expect(resultado).toBeNull();
    });

    test('no mezcla channels: un bundle "beta" no se ofrece a "production"', async () => {
      await service.publicarBundle({
        platform: 'android', channel: 'beta', version: '9.9.9',
        buffer: Buffer.from('beta'), publishedBy,
      });

      const resultado = await service.buscarActualizacion({
        platform: 'android', channel: 'production', versionActual: 'builtin',
      });

      expect(resultado).toBeNull();
    });
  });

  describe('buscarBundlePorFilename() / streamDeBundle()', () => {
    test('resuelve un filename real a su documento', async () => {
      const bundle = await service.publicarBundle({
        platform: 'android', channel: 'production', version: '1.0.0',
        buffer: Buffer.from('x'), publishedBy,
      });

      const encontrado = await service.buscarBundlePorFilename(bundle.filename);
      expect(encontrado._id.toString()).toBe(bundle._id.toString());
    });

    test('un filename inventado (no publicado) no resuelve a nada', async () => {
      const encontrado = await service.buscarBundlePorFilename('no-existe.zip');
      expect(encontrado).toBeNull();
    });

    test('streamDeBundle() de un filename inventado no permite escapar del directorio', () => {
      expect(() => service.streamDeBundle('../../../etc/passwd')).toThrow();
    });
  });
});
