// Test real (Jest, sin red — cloudinary.url()/private_download_url()
// construyen la URL localmente, no hacen ningún request) de
// businessAssetAccess.service.js — P0 de seguridad (auditoría Business
// Brain, 19/sep/2026, Bloque 1). Cubre el modo dual (campo nuevo *Asset
// vs. fallback a la URL vieja mientras un documento no se migró) y el TTL
// distinto por propósito (display vs. send).
const {
  resolverAsset,
  resolverFoto,
  generarUrlDeAcceso,
  obtenerUrlDeAcceso,
  obtenerUrlDeAccesoFoto,
  DURACION_SEGUNDOS,
} = require('./businessAssetAccess.service');

describe('businessAssetAccess.service — resolverAsset() / resolverFoto()', () => {
  test('documento YA migrado (tiene logoAsset): usa la forma nueva, tipoEntrega authenticated', () => {
    const business = { logoAsset: { publicId: 'creaos/businesses/1/logo/abc', resourceType: 'image' } };
    expect(resolverAsset(business, 'logo')).toEqual({
      publicId: 'creaos/businesses/1/logo/abc',
      resourceType: 'image',
      tipoEntrega: 'authenticated',
    });
  });

  test('documento SIN migrar (solo tiene la URL vieja): cae al fallback, tipoEntrega upload', () => {
    const business = { logo: 'https://res.cloudinary.com/aoptlpqk/image/upload/v123/creaos/businesses/1/logo/abc.png' };
    expect(resolverAsset(business, 'logo')).toEqual({
      publicId: 'creaos/businesses/1/logo/abc',
      resourceType: 'image',
      tipoEntrega: 'upload',
    });
  });

  test('sin ningún dato (ni Asset ni URL vieja): devuelve null, no lanza', () => {
    expect(resolverAsset({}, 'logo')).toBeNull();
    expect(resolverAsset({}, 'pdf')).toBeNull();
    expect(resolverAsset({}, 'presentationVideo')).toBeNull();
    expect(resolverAsset({}, 'brochure')).toBeNull();
  });

  test('resolverFoto(): usa photoAssets[index] si existe', () => {
    const business = { photoAssets: [{ publicId: 'creaos/businesses/1/photos/a', resourceType: 'image' }] };
    expect(resolverFoto(business, 0)).toEqual({
      publicId: 'creaos/businesses/1/photos/a',
      resourceType: 'image',
      tipoEntrega: 'authenticated',
    });
  });

  test('resolverFoto(): cae a photos[index] (URL vieja) si photoAssets no tiene ese índice', () => {
    const business = { photos: ['https://res.cloudinary.com/aoptlpqk/image/upload/v1/creaos/businesses/1/photos/b.jpg'] };
    expect(resolverFoto(business, 0)).toEqual({
      publicId: 'creaos/businesses/1/photos/b',
      resourceType: 'image',
      tipoEntrega: 'upload',
    });
  });

  test('resolverFoto(): índice fuera de rango devuelve null', () => {
    expect(resolverFoto({ photos: [] }, 0)).toBeNull();
    expect(resolverFoto({ photoAssets: [] }, 5)).toBeNull();
  });
});

describe('businessAssetAccess.service — generarUrlDeAcceso()', () => {
  test('tipoEntrega "upload" (todavía no migrado): devuelve la URL pública tal cual, sin firmar', () => {
    const url = generarUrlDeAcceso({ publicId: 'creaos/x/y', resourceType: 'image', tipoEntrega: 'upload' });
    expect(url).toContain('/image/upload/');
    expect(url).toContain('creaos/x/y');
    expect(url).not.toContain('expires_at');
  });

  test('tipoEntrega "authenticated": genera una URL firmada con expires_at real (no una constante)', () => {
    const antes = Math.floor(Date.now() / 1000);
    const url = generarUrlDeAcceso({ publicId: 'creaos/x/y', resourceType: 'image', tipoEntrega: 'authenticated' }, 'display');
    const match = url.match(/expires_at=(\d+)/);
    expect(match).not.toBeNull();
    const expiresAt = Number(match[1]);
    // Debe expirar en el futuro cercano (display = 15 min), no en el pasado ni en 48h.
    expect(expiresAt).toBeGreaterThan(antes);
    expect(expiresAt).toBeLessThanOrEqual(antes + DURACION_SEGUNDOS.display + 5);
  });

  test('propósito "send" usa una duración mucho mayor que "display" (restricción real: fetch asíncrono de Meta)', () => {
    const datos = { publicId: 'creaos/x/y', resourceType: 'video', tipoEntrega: 'authenticated' };
    const urlDisplay = generarUrlDeAcceso(datos, 'display');
    const urlSend = generarUrlDeAcceso(datos, 'send');
    const expiresDisplay = Number(urlDisplay.match(/expires_at=(\d+)/)[1]);
    const expiresSend = Number(urlSend.match(/expires_at=(\d+)/)[1]);
    expect(expiresSend - expiresDisplay).toBeGreaterThan(DURACION_SEGUNDOS.send - DURACION_SEGUNDOS.display - 5);
  });

  test('sin datos (null): devuelve null, no lanza', () => {
    expect(generarUrlDeAcceso(null)).toBeNull();
  });

  test('resourceType "raw" (PDF/brochure) usa la extensión .pdf, no la de imagen', () => {
    const url = generarUrlDeAcceso({ publicId: 'creaos/x/doc.pdf', resourceType: 'raw', tipoEntrega: 'authenticated' });
    expect(url).toContain('format=pdf');
  });
});

describe('businessAssetAccess.service — obtenerUrlDeAcceso() / obtenerUrlDeAccesoFoto() (integración de las 2 piezas)', () => {
  test('negocio sin migrar, con URL vieja de brochure: devuelve una URL pública usable', () => {
    const business = { brochureUrl: 'https://res.cloudinary.com/aoptlpqk/raw/upload/v1/creaos/businesses/1/brochure/x.pdf' };
    const url = obtenerUrlDeAcceso(business, 'brochure');
    expect(url).toContain('/raw/upload/');
  });

  test('negocio migrado, con brochureAsset: devuelve una URL firmada authenticated', () => {
    const business = { brochureAsset: { publicId: 'creaos/businesses/1/brochure/x.pdf', resourceType: 'raw' } };
    const url = obtenerUrlDeAcceso(business, 'brochure', 'send');
    expect(url).toContain('type=authenticated');
    expect(url).toContain('expires_at');
  });

  test('negocio sin ningún brochure cargado: devuelve null', () => {
    expect(obtenerUrlDeAcceso({}, 'brochure')).toBeNull();
  });

  test('obtenerUrlDeAccesoFoto() con negocio migrado', () => {
    const business = { photoAssets: [{ publicId: 'creaos/businesses/1/photos/a', resourceType: 'image' }] };
    const url = obtenerUrlDeAccesoFoto(business, 0);
    expect(url).toContain('type=authenticated');
  });
});
