// Test real (Jest, Mongo real, Cloudinary mockeado) de
// agregarFotoProducto()/eliminarFotoProducto() — Bloque 2 de la auditoría
// Business Brain (§37-39, 20/sep/2026). Cubre el auto-marcado de
// isPrimary (primera foto, o desmarcado de las demás al pedir una nueva
// principal), y la promoción automática de una nueva principal al borrar
// la que estaba marcada.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');

jest.mock('../../utils/cloudinary', () => ({
  cloudinary: { uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) } },
  subirBuffer: jest.fn(),
  extraerPublicId: jest.fn(),
  eliminarPorUrl: jest.fn(),
}));

const { cloudinary, subirBuffer } = require('../../utils/cloudinary');
const { agregarFotoProducto, eliminarFotoProducto } = require('./product.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_media_assets';

describe('product.service — agregarFotoProducto() / eliminarFotoProducto()', () => {
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

  const fotoFalsa = { buffer: Buffer.from('foto-falsa') };

  test('sube type:authenticated directo (nunca upload) — verifica el options exacto pasado a subirBuffer', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'creaos/products/x/y/photos/abc', resource_type: 'image' });

    await agregarFotoProducto(business._id, producto._id, fotoFalsa);

    expect(subirBuffer).toHaveBeenCalledWith(fotoFalsa.buffer, expect.objectContaining({ resource_type: 'image', type: 'authenticated' }));
  });

  test('la primera foto de un producto se marca isPrimary:true automáticamente', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'creaos/products/x/y/photos/a', resource_type: 'image' });

    const actualizado = await agregarFotoProducto(business._id, producto._id, fotoFalsa);

    expect(actualizado.mediaAssets).toHaveLength(1);
    expect(actualizado.mediaAssets[0].isPrimary).toBe(true);
  });

  test('una segunda foto SIN pedir isPrimary explícito queda en false (no pisa la principal existente)', async () => {
    subirBuffer.mockResolvedValueOnce({ public_id: 'a', resource_type: 'image' });
    await agregarFotoProducto(business._id, producto._id, fotoFalsa);

    subirBuffer.mockResolvedValueOnce({ public_id: 'b', resource_type: 'image' });
    const actualizado = await agregarFotoProducto(business._id, producto._id, fotoFalsa);

    expect(actualizado.mediaAssets.find((m) => m.publicId === 'a').isPrimary).toBe(true);
    expect(actualizado.mediaAssets.find((m) => m.publicId === 'b').isPrimary).toBe(false);
  });

  test('pedir isPrimary:true explícito en una foto nueva desmarca cualquier otra principal existente', async () => {
    subirBuffer.mockResolvedValueOnce({ public_id: 'a', resource_type: 'image' });
    await agregarFotoProducto(business._id, producto._id, fotoFalsa);

    subirBuffer.mockResolvedValueOnce({ public_id: 'b', resource_type: 'image' });
    const actualizado = await agregarFotoProducto(business._id, producto._id, fotoFalsa, { isPrimary: true });

    expect(actualizado.mediaAssets.find((m) => m.publicId === 'a').isPrimary).toBe(false);
    expect(actualizado.mediaAssets.find((m) => m.publicId === 'b').isPrimary).toBe(true);
  });

  test('guarda el caption cuando se manda', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'a', resource_type: 'image' });

    const actualizado = await agregarFotoProducto(business._id, producto._id, fotoFalsa, { caption: 'Vista frontal' });

    expect(actualizado.mediaAssets[0].caption).toBe('Vista frontal');
  });

  test('eliminarFotoProducto(): borra en Cloudinary (type:authenticated) y del array', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'creaos/products/x/y/photos/a', resource_type: 'image' });
    const conFoto = await agregarFotoProducto(business._id, producto._id, fotoFalsa);
    const mediaId = conFoto.mediaAssets[0]._id;

    const actualizado = await eliminarFotoProducto(business._id, producto._id, mediaId);

    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('creaos/products/x/y/photos/a', { resource_type: 'image', type: 'authenticated' });
    expect(actualizado.mediaAssets).toHaveLength(0);
  });

  test('eliminarFotoProducto(): si se borra la principal y quedan otras, promueve la primera restante (por order)', async () => {
    subirBuffer.mockResolvedValueOnce({ public_id: 'a', resource_type: 'image' });
    await agregarFotoProducto(business._id, producto._id, fotoFalsa); // principal, order 0
    subirBuffer.mockResolvedValueOnce({ public_id: 'b', resource_type: 'image' });
    const conDos = await agregarFotoProducto(business._id, producto._id, fotoFalsa); // order 1

    const idPrincipal = conDos.mediaAssets.find((m) => m.publicId === 'a')._id;
    const actualizado = await eliminarFotoProducto(business._id, producto._id, idPrincipal);

    expect(actualizado.mediaAssets).toHaveLength(1);
    expect(actualizado.mediaAssets[0].publicId).toBe('b');
    expect(actualizado.mediaAssets[0].isPrimary).toBe(true);
  });

  test('eliminarFotoProducto(): mediaId inexistente lanza 404, no llama a Cloudinary', async () => {
    await expect(
      eliminarFotoProducto(business._id, producto._id, new mongoose.Types.ObjectId())
    ).rejects.toThrow(/Foto no encontrada/);
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
  });

  test('eliminarFotoProducto(): si Cloudinary falla al borrar, no bloquea — igual se quita del array (best-effort)', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'a', resource_type: 'image' });
    const conFoto = await agregarFotoProducto(business._id, producto._id, fotoFalsa);
    cloudinary.uploader.destroy.mockRejectedValueOnce(new Error('Cloudinary caído'));

    const actualizado = await eliminarFotoProducto(business._id, producto._id, conFoto.mediaAssets[0]._id);

    expect(actualizado.mediaAssets).toHaveLength(0);
  });

  test('agregarFotoProducto(): producto de otro negocio (o inexistente) lanza 404, nunca sube a Cloudinary', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });

    await expect(
      agregarFotoProducto(otroBusiness._id, producto._id, fotoFalsa)
    ).rejects.toThrow(/Producto no encontrado/);
    expect(subirBuffer).not.toHaveBeenCalled();
  });
});
