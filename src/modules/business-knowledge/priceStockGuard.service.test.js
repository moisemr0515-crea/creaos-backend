// Test real (Jest, sin Mongo — product.service.js se mockea) de
// priceStockGuard.service.js — Bloque 3 de la auditoría Business Brain
// (§52/§54, 20/sep/2026), Fase 2 punto 5: la barrera de código que
// descarta chunks del PDF con precio/stock desactualizado, ANTES de que
// lleguen a la tool/al modelo. Nunca depende de que el modelo "elija
// bien" — se prueba acá que el descarte ocurre por construcción.
jest.mock('../products/product.service', () => ({ buscarProductos: jest.fn() }));
const productService = require('../products/product.service');

const {
  mencionaPrecioOStock,
  descartarClaimsDePrecioStockDesactualizados,
} = require('./priceStockGuard.service');

const BUSINESS_ID = 'business-de-prueba';

describe('mencionaPrecioOStock()', () => {
  test.each([
    ['La moringa cuesta S/. 45 el frasco de 100 cápsulas.', true],
    ['El precio incluye envío gratis a todo el país.', true],
    ['Tenemos stock disponible de todos los sabores.', true],
    ['Este producto está agotado hasta fin de mes.', true],
    ['Aceptamos pagos con Yape, Plin y tarjeta de crédito.', false],
    ['Nuestra empresa fue fundada en 2018 por dos socios.', false],
    ['Envíos a todo el país en 3 a 5 días hábiles.', false],
  ])('%s -> %s', (texto, esperado) => {
    expect(mencionaPrecioOStock(texto)).toBe(esperado);
  });
});

describe('descartarClaimsDePrecioStockDesactualizados()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('array vacío: no llama a buscarProductos, devuelve vacío', async () => {
    const resultado = await descartarClaimsDePrecioStockDesactualizados([], BUSINESS_ID);
    expect(resultado).toEqual([]);
    expect(productService.buscarProductos).not.toHaveBeenCalled();
  });

  test('chunk SIN señal de precio/stock: se conserva tal cual, nunca consulta el catálogo', async () => {
    const chunks = [{ text: 'Somos una empresa familiar con 10 años de experiencia.', page: 1, score: 0.8 }];

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, BUSINESS_ID);

    expect(resultado).toEqual(chunks);
    expect(productService.buscarProductos).not.toHaveBeenCalled();
  });

  test('chunk CON señal de precio, que matchea un producto real del catálogo: se DESCARTA', async () => {
    const chunks = [{ text: 'La moringa cuesta S/. 45 el frasco.', page: 2, score: 0.9 }];
    productService.buscarProductos.mockResolvedValue([
      { productId: 'p1', name: 'Moringa 100 cápsulas', matchScore: 0.85 },
    ]);

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, BUSINESS_ID);

    expect(resultado).toEqual([]);
    expect(productService.buscarProductos).toHaveBeenCalledWith(BUSINESS_ID, chunks[0].text);
  });

  test('chunk CON señal de precio, pero SIN ningún producto real que matchee: se conserva (no hay con qué contrastarlo)', async () => {
    const chunks = [{ text: 'El precio de nuestro servicio de consultoría se cotiza por proyecto.', page: 3, score: 0.7 }];
    productService.buscarProductos.mockResolvedValue([]);

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, BUSINESS_ID);

    expect(resultado).toEqual(chunks);
  });

  test('chunk CON señal de precio, con un match débil (matchScore bajo): se conserva — no hay evidencia suficiente de colisión real', async () => {
    const chunks = [{ text: 'El stock de accesorios varios puede variar.', page: 4, score: 0.6 }];
    productService.buscarProductos.mockResolvedValue([{ productId: 'p1', name: 'Algo sin relación real', matchScore: 0.1 }]);

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, BUSINESS_ID);

    expect(resultado).toEqual(chunks);
  });

  test('varios chunks: solo se descarta el que realmente colisiona, el resto se conserva intacto y en el mismo orden', async () => {
    const chunkSano1 = { text: 'Envíos gratis a todo el país.', page: 1, score: 0.9 };
    const chunkConflictivo = { text: 'La moringa cuesta S/. 45.', page: 2, score: 0.8 };
    const chunkSano2 = { text: 'Fundada en 2018, con presencia en 5 países.', page: 3, score: 0.7 };

    productService.buscarProductos.mockImplementation(async (businessId, texto) =>
      texto.includes('moringa') ? [{ productId: 'p1', name: 'Moringa', matchScore: 0.9 }] : []
    );

    const resultado = await descartarClaimsDePrecioStockDesactualizados(
      [chunkSano1, chunkConflictivo, chunkSano2],
      BUSINESS_ID
    );

    expect(resultado).toEqual([chunkSano1, chunkSano2]);
  });

  test('si buscarProductos() falla (ej. Mongo momentáneamente caído): el chunk se CONSERVA (fail-open), no rompe el retrieval entero', async () => {
    const chunks = [{ text: 'El precio de la moringa es S/. 45.', page: 1, score: 0.9 }];
    productService.buscarProductos.mockRejectedValue(new Error('Mongo caído'));

    const resultado = await descartarClaimsDePrecioStockDesactualizados(chunks, BUSINESS_ID);

    expect(resultado).toEqual(chunks);
  });
});
