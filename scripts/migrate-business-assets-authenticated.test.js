// Test real (Jest, Mongo real, Cloudinary + fetch mockeados) de
// scripts/migrate-business-assets-authenticated.js — P0 de seguridad
// Cloudinary (auditoría Business Brain, Bloque 1, Paso 3 del rollout).
//
// Cubre el diseño acordado con el usuario antes de correr el dry-run real:
//  - orden de seguridad (no se destruye el viejo hasta confirmar legible
//    el nuevo vía el MISMO mecanismo del proxy real);
//  - idempotencia (asset ya migrado: no vuelve a descargar/subir, solo
//    intenta destruir el viejo; destroy sobre un asset ya destruido no
//    es un error);
//  - si la verificación de legibilidad falla, no se toca Mongo ni se
//    destruye nada.
const mongoose = require('mongoose');

jest.mock('../src/utils/cloudinary', () => ({
  cloudinary: { uploader: { upload_stream: jest.fn(), destroy: jest.fn() } },
  extraerPublicId: jest.fn(),
}));
jest.mock('../src/modules/businesses/businessAssetAccess.service', () => ({
  generarUrlDeAcceso: jest.fn(),
}));

const { cloudinary, extraerPublicId } = require('../src/utils/cloudinary');
const { generarUrlDeAcceso } = require('../src/modules/businesses/businessAssetAccess.service');
const {
  migrarAsset,
  migrarNegocio,
  run,
  COLLECTION_NAME,
} = require('./migrate-business-assets-authenticated');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_migrate_business_assets_authenticated';

// upload_stream real es un stream — para el mock alcanza con un objeto que
// tenga .end() y dispare el callback con el resultado configurado.
function mockUploadStreamResultado(resultado) {
  cloudinary.uploader.upload_stream.mockImplementationOnce((options, callback) => ({
    end: () => callback(null, {
      format: resultado.resource_type === 'raw' ? 'pdf' : 'jpg',
      bytes: 123,
      type: 'authenticated',
      secure_url: `https://cloudinary.test/${resultado.resource_type}/authenticated/${resultado.public_id}`,
      ...resultado,
    }),
  }));
}

const respuestaDescarga = (contenido) => ({
  ok: true,
  headers: { get: () => 'image/png' },
  arrayBuffer: async () => Buffer.from(contenido),
});

const assetMigrado = (overrides = {}) => ({
  publicId: 'creaos/business-assets/logo/nuevo',
  resourceType: 'image',
  deliveryType: 'authenticated',
  legacyPublicId: 'creaos/x/logo/viejo',
  legacyResourceType: 'image',
  status: 'active',
  ...overrides,
});

describe('migrate-business-assets-authenticated', () => {
  let collection;
  let fetchOriginal;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
    collection = mongoose.connection.db.collection(COLLECTION_NAME);
    fetchOriginal = global.fetch;
  });

  afterAll(async () => {
    await collection.deleteMany({});
    await mongoose.disconnect();
    global.fetch = fetchOriginal;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    extraerPublicId.mockReset();
    cloudinary.uploader.upload_stream.mockReset();
    cloudinary.uploader.destroy.mockReset();
    generarUrlDeAcceso.mockReset();
    await collection.deleteMany({});
    global.fetch = jest.fn();
  });

  describe('migrarAsset — sin asset cargado o URL no reconocible', () => {
    test('sin urlVieja: accion "nada", no toca Cloudinary', async () => {
      const resultado = await migrarAsset({ etiqueta: 'logo', urlVieja: undefined, assetActual: undefined }, { confirm: false });

      expect(resultado).toEqual({ campo: 'logo', accion: 'nada', detalle: 'sin asset cargado' });
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    });

    test('URL no reconocible por extraerPublicId: accion "nada", no lanza', async () => {
      extraerPublicId.mockReturnValueOnce(null);

      const resultado = await migrarAsset({ etiqueta: 'logo', urlVieja: 'https://raro.example/logo.png', assetActual: undefined }, { confirm: false });

      expect(resultado.accion).toBe('nada');
      expect(resultado.detalle).toMatch(/no reconocible/);
    });
  });

  describe('migrarAsset — dry-run (confirm:false)', () => {
    test('asset sin migrar: describe la acción sin descargar/subir nada', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });

      const resultado = await migrarAsset(
        { etiqueta: 'logo', urlVieja: 'https://cloudinary.test/logo.png', assetActual: undefined },
        { confirm: false }
      );

      expect(resultado.accion).toBe('migrar_completo');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    });

    test('asset ya migrado: describe que solo falta confirmar destroy del viejo, no lo destruye todavía', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });

      const resultado = await migrarAsset(
        {
          etiqueta: 'logo',
          urlVieja: 'https://cloudinary.test/logo.png',
          assetActual: assetMigrado(),
        },
        { confirm: false }
      );

      expect(resultado.accion).toBe('verificar_y_destruir_viejo');
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });
  });

  describe('migrarAsset — confirm:true, asset sin migrar', () => {
    test('flujo completo exitoso: descarga, sube authenticated, verifica legible vía el proxy real, NO destruye el viejo (eso lo hace migrarNegocio después de escribir Mongo)', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });
      global.fetch
        .mockResolvedValueOnce(respuestaDescarga('bytes-del-logo')) // descarga
        .mockResolvedValueOnce({ ok: true }); // verificación HEAD
      mockUploadStreamResultado({ public_id: 'creaos/business-assets/logo/nuevo', resource_type: 'image' });
      generarUrlDeAcceso.mockReturnValueOnce('https://api.cloudinary.com/firmada');

      const resultado = await migrarAsset(
        { etiqueta: 'logo', urlVieja: 'https://cloudinary.test/logo.png', assetActual: undefined },
        { confirm: true }
      );

      expect(resultado.ok).toBe(true);
      expect(resultado.assetNuevo).toEqual(expect.objectContaining({
        publicId: 'creaos/business-assets/logo/nuevo', resourceType: 'image', deliveryType: 'authenticated',
        mimeType: 'image/png', originalName: 'logo.png', size: 123, status: 'active',
        legacyPublicId: 'creaos/x/logo/viejo',
      }));
      expect(resultado.locatorNuevo).toContain('/authenticated/');
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
      expect(generarUrlDeAcceso).toHaveBeenCalledWith(
        expect.objectContaining({ publicId: 'creaos/business-assets/logo/nuevo', resourceType: 'image', tipoEntrega: 'authenticated' }),
        'display'
      );
    });

    test('si la descarga del asset viejo falla (ej. 404 real — URL ya rota en la BD, sin relación con esta migración): ok:false, no lanza, no sube nada a Cloudinary', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/roto', resourceType: 'image' });
      global.fetch.mockRejectedValueOnce(new Error('Descarga falló: HTTP 404'));

      const resultado = await migrarAsset(
        { etiqueta: 'logo', urlVieja: 'https://cloudinary.test/roto.png', assetActual: undefined },
        { confirm: true }
      );

      expect(resultado.ok).toBe(false);
      expect(resultado.detalle).toMatch(/HTTP 404/);
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    });

    test('si la verificación de legibilidad falla (HEAD y GET no-ok): ok:false, no propone assetNuevo para escribir, no destruye', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });
      global.fetch
        .mockResolvedValueOnce(respuestaDescarga('bytes')) // descarga
        .mockResolvedValueOnce({ ok: false }) // HEAD falla
        .mockResolvedValueOnce({ ok: false }); // GET de respaldo también falla
      mockUploadStreamResultado({ public_id: 'creaos/business-assets/logo/nuevo', resource_type: 'image' });
      generarUrlDeAcceso.mockReturnValueOnce('https://api.cloudinary.com/firmada');

      const resultado = await migrarAsset(
        { etiqueta: 'logo', urlVieja: 'https://cloudinary.test/logo.png', assetActual: undefined },
        { confirm: true }
      );

      expect(resultado.ok).toBe(false);
      expect(resultado.assetNuevo).toBeUndefined();
      expect(resultado.detalle).toMatch(/NO se tocó Mongo ni se destruyó/);
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });

    test('si el proveedor no confirma type:authenticated, aborta ese asset sin tocar Mongo ni destruir el origen', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });
      global.fetch.mockResolvedValueOnce(respuestaDescarga('bytes'));
      mockUploadStreamResultado({
        public_id: 'creaos/business-assets/logo/incorrecto',
        resource_type: 'image',
        type: 'upload',
      });

      const resultado = await migrarAsset(
        { etiqueta: 'logo', urlVieja: 'https://cloudinary.test/logo.png', assetActual: undefined },
        { confirm: true }
      );

      expect(resultado.ok).toBe(false);
      expect(resultado.detalle).toMatch(/delivery inesperado/);
      expect(resultado.assetNuevo).toBeUndefined();
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });
  });

  describe('migrarAsset — confirm:true, asset ya migrado (idempotencia)', () => {
    test('no vuelve a descargar/subir — solo intenta destruir el viejo', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });
      cloudinary.uploader.destroy.mockResolvedValueOnce({ result: 'ok' });

      const resultado = await migrarAsset(
        {
          etiqueta: 'logo',
          urlVieja: 'https://cloudinary.test/logo.png',
          assetActual: assetMigrado(),
        },
        { confirm: true }
      );

      expect(global.fetch).not.toHaveBeenCalled();
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('creaos/x/logo/viejo', {
        resource_type: 'image', type: 'upload', invalidate: true,
      });
      expect(resultado.ok).toBe(true);
    });

    test('si el viejo ya fue destruido en una corrida anterior (destroy -> "not found"): no lanza, lo trata como no-op', async () => {
      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });
      cloudinary.uploader.destroy.mockResolvedValueOnce({ result: 'not found' });

      const resultado = await migrarAsset(
        {
          etiqueta: 'logo',
          urlVieja: 'https://cloudinary.test/logo.png',
          assetActual: assetMigrado(),
        },
        { confirm: true }
      );

      expect(resultado.ok).toBe(true);
      expect(resultado.detalle).toMatch(/not found/);
    });
  });

  describe('migrarNegocio — orquesta campos simples + fotos, escribe Mongo y destruye el viejo SOLO tras verificar legible', () => {
    test('migra logo + 1 foto: escribe logoAsset/photoAssets en Mongo y destruye ambos viejos', async () => {
      const business = await collection.insertOne({
        name: 'CREA OS',
        logo: 'https://cloudinary.test/logo.png',
        photos: ['https://cloudinary.test/foto.png'],
      }).then((r) => collection.findOne({ _id: r.insertedId }));

      extraerPublicId
        .mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' }) // logo (migrarAsset)
        .mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' }) // logo (destroy en migrarNegocio)
        .mockReturnValueOnce({ publicId: 'creaos/x/foto/vieja', resourceType: 'image' }) // photo[0] (migrarAsset)
        .mockReturnValueOnce({ publicId: 'creaos/x/foto/vieja', resourceType: 'image' }); // photo[0] (destroy en migrarNegocio)

      global.fetch
        .mockResolvedValueOnce(respuestaDescarga('logo-bytes'))
        .mockResolvedValueOnce({ ok: true }) // verificación logo
        .mockResolvedValueOnce(respuestaDescarga('foto-bytes'))
        .mockResolvedValueOnce({ ok: true }); // verificación foto

      mockUploadStreamResultado({ public_id: 'creaos/business-assets/logo/nuevo', resource_type: 'image' });
      mockUploadStreamResultado({ public_id: 'creaos/business-assets/photos/nueva', resource_type: 'image' });
      generarUrlDeAcceso.mockReturnValue('https://api.cloudinary.com/firmada');
      cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });

      await migrarNegocio(collection, business, { confirm: true });

      const releido = await collection.findOne({ _id: business._id });
      expect(releido.logoAsset).toEqual(expect.objectContaining({
        publicId: 'creaos/business-assets/logo/nuevo', deliveryType: 'authenticated', businessId: business._id,
      }));
      expect(releido.photoAssets[0]).toEqual(expect.objectContaining({
        publicId: 'creaos/business-assets/photos/nueva', deliveryType: 'authenticated', businessId: business._id,
      }));
      expect(releido.logo).toContain('/authenticated/');
      expect(releido.photos[0]).toContain('/authenticated/');
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('creaos/x/logo/viejo', expect.objectContaining({ type: 'upload', invalidate: true }));
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('creaos/x/foto/vieja', expect.objectContaining({ type: 'upload', invalidate: true }));
    });

    test('si la verificación de legibilidad falla: NO escribe el campo Asset en Mongo ni destruye el viejo', async () => {
      const business = await collection.insertOne({
        name: 'Myrel Company',
        logo: 'https://cloudinary.test/logo.png',
      }).then((r) => collection.findOne({ _id: r.insertedId }));

      extraerPublicId.mockReturnValueOnce({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });
      global.fetch
        .mockResolvedValueOnce(respuestaDescarga('logo-bytes'))
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });
      mockUploadStreamResultado({ public_id: 'creaos/business-assets/logo/nuevo', resource_type: 'image' });
      generarUrlDeAcceso.mockReturnValueOnce('https://api.cloudinary.com/firmada');

      await migrarNegocio(collection, business, { confirm: true });

      const releido = await collection.findOne({ _id: business._id });
      expect(releido.logoAsset).toBeUndefined();
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });
  });

  describe('migrarNegocio — aislamiento de fallos por asset (bug real detectado en producción: un 404 en un asset abortaba TODA la migración, incluyendo negocios siguientes)', () => {
    test('un asset roto (descarga falla) no impide migrar los OTROS assets del mismo negocio', async () => {
      const business = await collection.insertOne({
        name: 'Myrel Company',
        logo: 'https://cloudinary.test/logo-roto.jpg', // simula el 404 real de Myrel
        photos: ['https://cloudinary.test/foto-ok.png'],
      }).then((r) => collection.findOne({ _id: r.insertedId }));

      extraerPublicId
        .mockReturnValueOnce({ publicId: 'creaos/x/logo/roto', resourceType: 'image' }) // logo (migrarAsset)
        .mockReturnValueOnce({ publicId: 'creaos/x/foto/vieja', resourceType: 'image' }) // photo[0] (migrarAsset)
        .mockReturnValueOnce({ publicId: 'creaos/x/foto/vieja', resourceType: 'image' }); // photo[0] (destroy en migrarNegocio)

      global.fetch
        .mockRejectedValueOnce(new Error('Descarga falló: HTTP 404')) // logo roto
        .mockResolvedValueOnce(respuestaDescarga('foto-bytes')) // foto ok
        .mockResolvedValueOnce({ ok: true }); // verificación foto

      mockUploadStreamResultado({ public_id: 'creaos/business-assets/photos/nueva', resource_type: 'image' });
      generarUrlDeAcceso.mockReturnValue('https://api.cloudinary.com/firmada');
      cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });

      const resultados = await migrarNegocio(collection, business, { confirm: true });

      const resultadoLogo = resultados.find((r) => r.campo === 'logo');
      const resultadoFoto = resultados.find((r) => r.campo === 'photo[0]');
      expect(resultadoLogo.ok).toBe(false);
      expect(resultadoFoto.ok).toBe(true);

      const releido = await collection.findOne({ _id: business._id });
      expect(releido.logoAsset).toBeUndefined(); // el roto no se tocó
      expect(releido.photoAssets[0]).toEqual(expect.objectContaining({ publicId: 'creaos/business-assets/photos/nueva', deliveryType: 'authenticated' })); // la otra sí migró
    });
  });

  describe('run — dry-run vs --confirm sobre varios negocios', () => {
    test('dry-run: no escribe nada en ningún negocio', async () => {
      await collection.insertMany([
        { name: 'CREA OS', logo: 'https://cloudinary.test/logo.png' },
        { name: 'Negocio sin assets' },
      ]);
      extraerPublicId.mockReturnValue({ publicId: 'creaos/x/logo/viejo', resourceType: 'image' });

      const { totalAcciones } = await run(collection, { confirm: false });

      expect(totalAcciones).toBe(1);
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
      const doc = await collection.findOne({ name: 'CREA OS' });
      expect(doc.logoAsset).toBeUndefined();
    });

    test('un negocio con un asset roto no impide migrar el negocio SIGUIENTE (el bug real: antes, esto abortaba toda la corrida)', async () => {
      await collection.insertMany([
        { name: 'Myrel Company', logo: 'https://cloudinary.test/logo-roto.jpg' },
        { name: 'Herbalife', logo: 'https://cloudinary.test/logo-ok.jpg' },
      ]);

      extraerPublicId
        .mockReturnValueOnce({ publicId: 'creaos/x/myrel-logo/roto', resourceType: 'image' }) // Myrel logo (migrarAsset)
        .mockReturnValueOnce({ publicId: 'creaos/x/herbalife-logo/vieja', resourceType: 'image' }) // Herbalife logo (migrarAsset)
        .mockReturnValueOnce({ publicId: 'creaos/x/herbalife-logo/vieja', resourceType: 'image' }); // Herbalife logo (destroy)

      global.fetch
        .mockRejectedValueOnce(new Error('Descarga falló: HTTP 404')) // Myrel roto
        .mockResolvedValueOnce(respuestaDescarga('logo-bytes')) // Herbalife ok
        .mockResolvedValueOnce({ ok: true }); // verificación Herbalife

      mockUploadStreamResultado({ public_id: 'creaos/business-assets/logo/herbalife-nuevo', resource_type: 'image' });
      generarUrlDeAcceso.mockReturnValue('https://api.cloudinary.com/firmada');
      cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });

      const { totalAcciones } = await run(collection, { confirm: true });

      expect(totalAcciones).toBe(2);
      const myrel = await collection.findOne({ name: 'Myrel Company' });
      const herbalife = await collection.findOne({ name: 'Herbalife' });
      expect(myrel.logoAsset).toBeUndefined(); // roto, sin tocar
      expect(herbalife.logoAsset).toEqual(expect.objectContaining({ publicId: 'creaos/business-assets/logo/herbalife-nuevo', deliveryType: 'authenticated' })); // migró igual
    });

    test('negocios sin ningún asset legacy: 0 acciones, no tocan Cloudinary', async () => {
      await collection.insertMany([{ name: 'Negocio 1' }, { name: 'Negocio 2' }]);

      const { totalAcciones } = await run(collection, { confirm: true });

      expect(totalAcciones).toBe(0);
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });
  });
});
