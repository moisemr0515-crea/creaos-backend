// Test real (Jest, Mongo real, Cloudinary mockeado) del dual-write de los
// campos *Asset — P0 de seguridad (auditoría Business Brain, 19/sep/2026,
// Bloque 1, Paso 1/2 del rollout, ver docs/business-brain-audit/). Cada
// upload nuevo deja poblada la forma NUEVA (publicId/resourceType) sin
// tocar el campo viejo (URL) — y eliminarAssetAnterior() (el 4to
// consumidor encontrado en la Fase 1) usa la forma nueva cuando existe,
// cae a eliminarPorUrl() cuando no.
const mongoose = require('mongoose');
const Business = require('./business.model');
require('../users/user.model');

jest.mock('../../utils/cloudinary', () => ({
  cloudinary: { uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) } },
  subirBuffer: jest.fn(),
  eliminarPorUrl: jest.fn().mockResolvedValue(undefined),
}));

const { cloudinary, subirBuffer, eliminarPorUrl } = require('../../utils/cloudinary');
const { subirLogo, subirFotos } = require('./business.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_business_asset_dual_write';

describe('business.service — dual-write de campos *Asset (subirLogo)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
  });

  const logoFalso = { buffer: Buffer.from('logo-falso') };

  test('subir un logo nuevo puebla logoAsset con publicId/resourceType, sin tocar el campo logo viejo', async () => {
    subirBuffer.mockResolvedValue({
      secure_url: 'https://cloudinary.test/logo.png',
      public_id: 'creaos/businesses/x/logo/abc',
      resource_type: 'image',
    });

    const actualizado = await subirLogo(business._id, logoFalso);

    expect(actualizado.logo).toBe('https://cloudinary.test/logo.png');
    expect(actualizado.logoAsset).toEqual(
      expect.objectContaining({ publicId: 'creaos/businesses/x/logo/abc', resourceType: 'image' }),
    );

    const releido = await Business.findById(business._id);
    expect(releido.logoAsset.publicId).toBe('creaos/businesses/x/logo/abc');
  });

  test('reemplazar un logo que YA tiene logoAsset (documento migrado): borra por publicId/resourceType, NO por eliminarPorUrl()', async () => {
    await Business.findByIdAndUpdate(business._id, {
      logo: 'https://cloudinary.test/viejo.png',
      logoAsset: { publicId: 'creaos/businesses/x/logo/viejo', resourceType: 'image' },
    });
    subirBuffer.mockResolvedValue({
      secure_url: 'https://cloudinary.test/nuevo.png',
      public_id: 'creaos/businesses/x/logo/nuevo',
      resource_type: 'image',
    });

    await subirLogo(business._id, logoFalso);

    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('creaos/businesses/x/logo/viejo', { resource_type: 'image' });
    expect(eliminarPorUrl).not.toHaveBeenCalled();
  });

  test('reemplazar un logo SIN logoAsset todavía (documento sin migrar): cae a eliminarPorUrl() sobre la URL vieja, mismo comportamiento que antes de este cambio', async () => {
    await Business.findByIdAndUpdate(business._id, { logo: 'https://cloudinary.test/viejo-legacy.png' });
    subirBuffer.mockResolvedValue({
      secure_url: 'https://cloudinary.test/nuevo.png',
      public_id: 'creaos/businesses/x/logo/nuevo',
      resource_type: 'image',
    });

    await subirLogo(business._id, logoFalso);

    expect(eliminarPorUrl).toHaveBeenCalledWith('https://cloudinary.test/viejo-legacy.png', expect.anything());
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
  });
});

describe('business.service — dual-write de campos *Asset (subirFotos)', () => {
  let business;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Business.deleteMany({});
    business = await Business.create({ name: 'CREA OS' });
  });

  test('subir 2 fotos puebla photoAssets en el mismo orden que photos', async () => {
    subirBuffer
      .mockResolvedValueOnce({ secure_url: 'https://cloudinary.test/a.jpg', public_id: 'creaos/x/photos/a', resource_type: 'image' })
      .mockResolvedValueOnce({ secure_url: 'https://cloudinary.test/b.jpg', public_id: 'creaos/x/photos/b', resource_type: 'image' });

    const actualizado = await subirFotos(business._id, [
      { buffer: Buffer.from('a') },
      { buffer: Buffer.from('b') },
    ]);

    expect(actualizado.photos).toEqual(['https://cloudinary.test/a.jpg', 'https://cloudinary.test/b.jpg']);
    expect(actualizado.photoAssets).toEqual([
      expect.objectContaining({ publicId: 'creaos/x/photos/a', resourceType: 'image' }),
      expect.objectContaining({ publicId: 'creaos/x/photos/b', resourceType: 'image' }),
    ]);
  });

  test('reemplazar fotos ya migradas (con photoAssets): borra cada una por publicId, no por URL', async () => {
    await Business.findByIdAndUpdate(business._id, {
      photos: ['https://cloudinary.test/vieja.jpg'],
      photoAssets: [{ publicId: 'creaos/x/photos/vieja', resourceType: 'image' }],
    });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/nueva.jpg', public_id: 'creaos/x/photos/nueva', resource_type: 'image' });

    await subirFotos(business._id, [{ buffer: Buffer.from('nueva') }]);

    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('creaos/x/photos/vieja', { resource_type: 'image' });
    expect(eliminarPorUrl).not.toHaveBeenCalled();
  });

  test('reemplazar fotos sin migrar (sin photoAssets): cae a eliminarPorUrl() por cada URL vieja', async () => {
    await Business.findByIdAndUpdate(business._id, { photos: ['https://cloudinary.test/vieja-legacy.jpg'] });
    subirBuffer.mockResolvedValue({ secure_url: 'https://cloudinary.test/nueva.jpg', public_id: 'creaos/x/photos/nueva', resource_type: 'image' });

    await subirFotos(business._id, [{ buffer: Buffer.from('nueva') }]);

    expect(eliminarPorUrl).toHaveBeenCalledWith('https://cloudinary.test/vieja-legacy.jpg', expect.anything());
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
  });
});
