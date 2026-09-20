// Test real (Jest, sin red — cloudinary.utils.private_download_url()
// construye la URL localmente) de productAssetAccess.service.js — Bloque 2
// de la auditoría Business Brain (§37-39, 20/sep/2026). Cubre la selección
// de "foto principal" (isPrimary vs. fallback a la primera), la resolución
// por id, y que la firma real (TTL/authenticated) se delega tal cual al
// mecanismo compartido ya probado en businessAssetAccess.service.test.js.
const {
  resolverFotoPrincipal,
  resolverFotoPorId,
  resolverFotos,
  obtenerUrlDeAccesoFotoPrincipal,
  obtenerUrlDeAccesoFotoPorId,
} = require('./productAssetAccess.service');

describe('productAssetAccess.service — resolverFotoPrincipal()', () => {
  test('sin ninguna foto cargada: devuelve null', () => {
    expect(resolverFotoPrincipal({ mediaAssets: [] })).toBeNull();
    expect(resolverFotoPrincipal({})).toBeNull();
  });

  test('con 1 sola foto (sin isPrimary marcado): la devuelve igual, es la única candidata', () => {
    const producto = { mediaAssets: [{ _id: '1', publicId: 'creaos/products/x/a', resourceType: 'image' }] };
    expect(resolverFotoPrincipal(producto)).toEqual({
      publicId: 'creaos/products/x/a',
      resourceType: 'image',
      tipoEntrega: 'authenticated',
      caption: null,
    });
  });

  test('con varias fotos y una marcada isPrimary:true: devuelve ESA, sin importar su posición en el array', () => {
    const producto = {
      mediaAssets: [
        { _id: '1', publicId: 'creaos/products/x/a', resourceType: 'image', isPrimary: false },
        { _id: '2', publicId: 'creaos/products/x/b', resourceType: 'image', isPrimary: true, caption: 'Vista frontal' },
        { _id: '3', publicId: 'creaos/products/x/c', resourceType: 'image', isPrimary: false },
      ],
    };
    expect(resolverFotoPrincipal(producto)).toEqual({
      publicId: 'creaos/products/x/b',
      resourceType: 'image',
      tipoEntrega: 'authenticated',
      caption: 'Vista frontal',
    });
  });

  test('con varias fotos y NINGUNA marcada isPrimary: cae a la primera del array (nunca ambiguo, nunca null teniendo fotos)', () => {
    const producto = {
      mediaAssets: [
        { _id: '1', publicId: 'creaos/products/x/a', resourceType: 'image' },
        { _id: '2', publicId: 'creaos/products/x/b', resourceType: 'image' },
      ],
    };
    expect(resolverFotoPrincipal(producto)?.publicId).toBe('creaos/products/x/a');
  });
});

describe('productAssetAccess.service — resolverFotoPorId()', () => {
  const producto = {
    mediaAssets: [
      { _id: 'abc123', publicId: 'creaos/products/x/a', resourceType: 'image', caption: 'Caja' },
    ],
  };

  test('id existente: la resuelve', () => {
    expect(resolverFotoPorId(producto, 'abc123')).toEqual({
      publicId: 'creaos/products/x/a',
      resourceType: 'image',
      tipoEntrega: 'authenticated',
      caption: 'Caja',
    });
  });

  test('id inexistente: null, no lanza', () => {
    expect(resolverFotoPorId(producto, 'no-existe')).toBeNull();
  });
});

describe('productAssetAccess.service — resolverFotos()', () => {
  test('devuelve todas ordenadas por `order`, sin importar el orden del array original', () => {
    const producto = {
      mediaAssets: [
        { _id: '1', publicId: 'a', resourceType: 'image', order: 2 },
        { _id: '2', publicId: 'b', resourceType: 'image', order: 0 },
        { _id: '3', publicId: 'c', resourceType: 'image', order: 1 },
      ],
    };
    expect(resolverFotos(producto).map((f) => f.publicId)).toEqual(['b', 'c', 'a']);
  });

  test('sin fotos: array vacío', () => {
    expect(resolverFotos({ mediaAssets: [] })).toEqual([]);
  });
});

describe('productAssetAccess.service — obtenerUrlDeAccesoFotoPrincipal() / obtenerUrlDeAccesoFotoPorId() (integración con la firma real)', () => {
  test('genera una URL firmada authenticated para la foto principal', () => {
    const producto = { mediaAssets: [{ _id: '1', publicId: 'creaos/products/x/a', resourceType: 'image', isPrimary: true }] };
    const url = obtenerUrlDeAccesoFotoPrincipal(producto, 'send');
    expect(url).toContain('type=authenticated');
    expect(url).toContain('expires_at');
  });

  test('producto sin fotos: null', () => {
    expect(obtenerUrlDeAccesoFotoPrincipal({ mediaAssets: [] })).toBeNull();
  });

  test('obtenerUrlDeAccesoFotoPorId con un id válido', () => {
    const producto = { mediaAssets: [{ _id: 'xyz', publicId: 'creaos/products/x/b', resourceType: 'image' }] };
    expect(obtenerUrlDeAccesoFotoPorId(producto, 'xyz')).toContain('type=authenticated');
  });
});
