// Test real (Jest, Mongo real, Cloudinary mockeado) de
// agregarFotoProducto()/eliminarFotoProducto() — Bloque 2 de la auditoría
// Business Brain (§37-39, 20/sep/2026). Cubre el auto-marcado de
// isPrimary (primera foto, o desmarcado de las demás al pedir una nueva
// principal), y la promoción automática de una nueva principal al borrar
// la que estaba marcada.
const mongoose = require('mongoose');
const Business = require('../businesses/business.model');
const Product = require('./product.model');
const AssetCleanup = require('./assetCleanup.model');

jest.mock('../../utils/cloudinary', () => ({
  cloudinary: { uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) } },
  subirBuffer: jest.fn(),
  extraerPublicId: jest.fn(),
  eliminarPorUrl: jest.fn(),
}));

const { cloudinary, subirBuffer } = require('../../utils/cloudinary');
const { agregarFotoProducto, eliminarFotoProducto } = require('./product.service');
const { destroyAssetOrRecordPending } = require('./assetCleanup.service');

const MONGO_URI = 'mongodb://localhost:27017/creaos_test_product_media_assets';

describe('product.service — agregarFotoProducto() / eliminarFotoProducto()', () => {
  let business;
  let producto;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI);
  });

  afterAll(async () => {
    await AssetCleanup.deleteMany({});
    await Product.deleteMany({});
    await Business.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await AssetCleanup.deleteMany({});
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
    await expect(AssetCleanup.findOne({ business: business._id, publicId: 'a' }).lean()).resolves.toMatchObject({
      status: 'pending', reason: 'delete_provider_failure',
    });
  });

  test('agregarFotoProducto(): si DB falla después del upload destruye solo el asset recién creado y preserva el error DB', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'orphan-upload', resource_type: 'image' });
    jest.spyOn(Product.prototype, 'save').mockRejectedValueOnce(new Error('DB save failed'));

    await expect(agregarFotoProducto(business._id, producto._id, fotoFalsa)).rejects.toThrow('DB save failed');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('orphan-upload', {
      resource_type: 'image', type: 'authenticated',
    });
  });

  test('si cleanup compensatorio también falla registra una tarea pending sin ocultar el error DB', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'orphan-pending', resource_type: 'image' });
    jest.spyOn(Product.prototype, 'save').mockRejectedValueOnce(new Error('DB save failed'));
    cloudinary.uploader.destroy.mockRejectedValueOnce(new Error('Cloudinary down'));

    await expect(agregarFotoProducto(business._id, producto._id, fotoFalsa)).rejects.toThrow('DB save failed');
    await expect(AssetCleanup.findOne({ business: business._id, publicId: 'orphan-pending' }).lean()).resolves.toMatchObject({
      status: 'pending', reason: 'upload_db_failure', lastError: 'Cloudinary down',
    });
  });

  test('registrar cleanup pendiente es idempotente para el mismo asset tenant-safe', async () => {
    cloudinary.uploader.destroy.mockRejectedValue(new Error('Cloudinary down'));
    const asset = { publicId: 'same-orphan', resourceType: 'image', deliveryType: 'authenticated' };

    await destroyAssetOrRecordPending({ businessId: business._id, asset, reason: 'delete_provider_failure' });
    await destroyAssetOrRecordPending({ businessId: business._id, asset, reason: 'delete_provider_failure' });

    expect(await AssetCleanup.countDocuments({ business: business._id, publicId: asset.publicId })).toBe(1);
    expect((await AssetCleanup.findOne({ business: business._id, publicId: asset.publicId })).attemptCount).toBe(2);
  });

  test('el mismo publicId en tenants distintos mantiene tareas de cleanup separadas', async () => {
    const otherBusiness = await Business.create({ name: 'Otro tenant cleanup' });
    cloudinary.uploader.destroy.mockRejectedValue(new Error('Cloudinary down'));
    const asset = { publicId: 'shared-public-id', resourceType: 'image', deliveryType: 'authenticated' };

    await destroyAssetOrRecordPending({ businessId: business._id, asset, reason: 'delete_provider_failure' });
    await destroyAssetOrRecordPending({ businessId: otherBusiness._id, asset, reason: 'delete_provider_failure' });

    expect(await AssetCleanup.countDocuments({ publicId: asset.publicId })).toBe(2);
  });

  test('si falla DB al retirar metadata, no llama a Cloudinary y la referencia permanece intacta', async () => {
    subirBuffer.mockResolvedValue({ public_id: 'keep-on-db-failure', resource_type: 'image' });
    const conFoto = await agregarFotoProducto(business._id, producto._id, fotoFalsa);
    cloudinary.uploader.destroy.mockClear();
    jest.spyOn(Product.prototype, 'save').mockRejectedValueOnce(new Error('DB delete save failed'));

    await expect(eliminarFotoProducto(business._id, producto._id, conFoto.mediaAssets[0]._id))
      .rejects.toThrow('DB delete save failed');
    expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    expect((await Product.findById(producto._id)).mediaAssets).toHaveLength(1);
  });

  test('agregarFotoProducto(): producto de otro negocio (o inexistente) lanza 404, nunca sube a Cloudinary', async () => {
    const otroBusiness = await Business.create({ name: 'Otro negocio' });

    await expect(
      agregarFotoProducto(otroBusiness._id, producto._id, fotoFalsa)
    ).rejects.toThrow(/Producto no encontrado/);
    expect(subirBuffer).not.toHaveBeenCalled();
  });
});
