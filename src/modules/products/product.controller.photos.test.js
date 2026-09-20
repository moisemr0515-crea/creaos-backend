// Test real (Jest, Mongo real, Cloudinary mockeado) de los 3 endpoints de
// fotos de producto — Bloque 2 de la auditoría Business Brain (§37-39,
// 20/sep/2026). Mismo patrón que product.controller.test.js: controller
// invocado directo con req/res/next mockeados, foco en que `business`
// SIEMPRE sale de req.businessId (nunca de params/body) y que el acceso a
// fotos nunca expone el publicId/URL directa.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');

jest.mock('../../utils/cloudinary', () => ({
  cloudinary: { uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) } },
  subirBuffer: jest.fn(),
  extraerPublicId: jest.fn(),
  eliminarPorUrl: jest.fn(),
}));

// getProductPhotoAccess ya no ejercita la firma real acá — tiene su propio
// test dedicado (productAssetAccess.service.test.js), mismo criterio que
// tools/index.sendMedia.test.js mockea businessAssetAccess.service entero.
jest.mock('./productAssetAccess.service');

const { subirBuffer } = require('../../utils/cloudinary');
const { obtenerUrlDeAccesoFotoPorId } = require('./productAssetAccess.service');
const {
  uploadProductPhoto,
  deleteProductPhoto,
  getProductPhotoAccess,
} = require('./product.controller');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_controller_photos';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const req = (overrides = {}) => ({
  user: { _id: new mongoose.Types.ObjectId(), name: 'Usuario de prueba' },
  body: {},
  query: {},
  params: {},
  ...overrides,
});

describe('product.controller — fotos de producto', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Product.deleteMany({});
    await Business.deleteMany({});
    business = await Business.create({ name: 'Negocio de prueba' });
    producto = await Product.create({ business: business._id, sku: 'MOR-001', name: 'Moringa' });
  });

  describe('uploadProductPhoto', () => {
    test('201, sube y agrega a mediaAssets, usa SIEMPRE req.businessId (nunca uno de params/body)', async () => {
      subirBuffer.mockResolvedValue({ public_id: 'creaos/products/x/y/a', resource_type: 'image' });
      const next = jest.fn();
      const res = mockRes();

      await uploadProductPhoto(
        req({ businessId: business._id, params: { id: producto._id.toString() }, file: { buffer: Buffer.from('x') } }),
        res,
        next
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      const productoGuardado = await Product.findById(producto._id);
      expect(productoGuardado.mediaAssets).toHaveLength(1);
    });

    test('sin req.file: 400, nunca llega a subirBuffer', async () => {
      const next = jest.fn();

      await uploadProductPhoto(req({ businessId: business._id, params: { id: producto._id.toString() } }), mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
      expect(subirBuffer).not.toHaveBeenCalled();
    });

    test('producto de OTRO negocio (id real pero de otro tenant): 404, nunca sube nada', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const next = jest.fn();

      await uploadProductPhoto(
        req({ businessId: otroBusiness._id, params: { id: producto._id.toString() }, file: { buffer: Buffer.from('x') } }),
        mockRes(),
        next
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(subirBuffer).not.toHaveBeenCalled();
    });
  });

  describe('deleteProductPhoto', () => {
    test('borra la foto correcta por mediaId', async () => {
      subirBuffer.mockResolvedValue({ public_id: 'a', resource_type: 'image' });
      const next = jest.fn();
      await uploadProductPhoto(
        req({ businessId: business._id, params: { id: producto._id.toString() }, file: { buffer: Buffer.from('x') } }),
        mockRes(),
        next
      );
      const conFoto = await Product.findById(producto._id);
      const mediaId = conFoto.mediaAssets[0]._id.toString();

      const res = mockRes();
      await deleteProductPhoto(req({ businessId: business._id, params: { id: producto._id.toString(), mediaId } }), res, next);

      expect(res.status).not.toHaveBeenCalledWith(404);
      const final = await Product.findById(producto._id);
      expect(final.mediaAssets).toHaveLength(0);
    });
  });

  describe('getProductPhotoAccess', () => {
    test('delega en productAssetAccess.service con proposito "display", y esa URL es la que devuelve', async () => {
      obtenerUrlDeAccesoFotoPorId.mockReturnValue('https://api.cloudinary.com/firmada?type=authenticated');
      const res = mockRes();
      const next = jest.fn();

      await getProductPhotoAccess(
        req({ businessId: business._id, params: { id: producto._id.toString(), mediaId: 'cualquiera' } }),
        res,
        next
      );

      expect(next).not.toHaveBeenCalled();
      expect(obtenerUrlDeAccesoFotoPorId).toHaveBeenCalledWith(
        expect.objectContaining({ _id: producto._id }),
        'cualquiera',
        'display'
      );
      const payload = res.json.mock.calls[0][0];
      expect(payload.data.url).toBe('https://api.cloudinary.com/firmada?type=authenticated');
    });

    test('foto inexistente (servicio devuelve null): 404 vía next(), no lanza sin manejar', async () => {
      obtenerUrlDeAccesoFotoPorId.mockReturnValue(null);
      const next = jest.fn();

      await getProductPhotoAccess(
        req({ businessId: business._id, params: { id: producto._id.toString(), mediaId: 'no-existe' } }),
        mockRes(),
        next
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    test('producto de OTRO negocio: 404 antes de siquiera resolver la foto', async () => {
      const otroBusiness = await Business.create({ name: 'Otro negocio' });
      const next = jest.fn();

      await getProductPhotoAccess(
        req({ businessId: otroBusiness._id, params: { id: producto._id.toString(), mediaId: 'x' } }),
        mockRes(),
        next
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
      expect(obtenerUrlDeAccesoFotoPorId).not.toHaveBeenCalled();
    });
  });
});
