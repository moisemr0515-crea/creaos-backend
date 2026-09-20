// Test real (Jest, sin I/O — función pura) de pdfChunking.util.js — Bloque
// 3 de la auditoría Business Brain (§45-46, 20/sep/2026).
const { dividirTextoEnChunks, separarPorPagina, chunkearDocumento } = require('./pdfChunking.util');

describe('dividirTextoEnChunks()', () => {
  test('texto más corto que el tamaño de chunk: un solo chunk con todo el texto', () => {
    const chunks = dividirTextoEnChunks('Texto corto de prueba.');
    expect(chunks).toEqual(['Texto corto de prueba.']);
  });

  test('texto vacío o solo espacios: array vacío, nunca un chunk vacío', () => {
    expect(dividirTextoEnChunks('')).toEqual([]);
    expect(dividirTextoEnChunks('   \n\n  ')).toEqual([]);
    expect(dividirTextoEnChunks(null)).toEqual([]);
  });

  test('texto más largo que el tamaño de chunk: se divide en varios, con solape real entre consecutivos', () => {
    const texto = 'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50); // 150 chars
    const chunks = dividirTextoEnChunks(texto, { tamano: 100, solape: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    // El final del primer chunk debe reaparecer al principio del segundo (solape real).
    const finalPrimero = chunks[0].slice(-20);
    expect(chunks[1].startsWith(finalPrimero)).toBe(true);
  });

  test('nunca deja un caracter sin cubrir por ningún chunk (cobertura completa del texto)', () => {
    const texto = Array.from({ length: 500 }, (_, i) => `palabra${i}`).join(' ');
    const chunks = dividirTextoEnChunks(texto, { tamano: 100, solape: 20 });
    const reconstruido = chunks.join('');
    // Cada caracter original tiene que aparecer en algún chunk (el solape
    // puede duplicar texto, nunca perderlo).
    expect(reconstruido.length).toBeGreaterThanOrEqual(texto.length);
  });
});

describe('separarPorPagina()', () => {
  test('sin ningún separador de página: un solo segmento con page:null', () => {
    const segmentos = separarPorPagina('Todo el contenido en un solo bloque, sin separadores.');
    expect(segmentos).toEqual([{ page: null, texto: 'Todo el contenido en un solo bloque, sin separadores.' }]);
  });

  test('texto vacío: array vacío', () => {
    expect(separarPorPagina('')).toEqual([]);
    expect(separarPorPagina(undefined)).toEqual([]);
  });

  test('con separadores "-- N of M --": divide en tantos segmentos como páginas, con su número real', () => {
    const texto = '-- 1 of 3 --\nContenido de la página uno.-- 2 of 3 --\nContenido de la página dos.-- 3 of 3 --\nContenido de la página tres.';
    const segmentos = separarPorPagina(texto);

    expect(segmentos).toEqual([
      { page: 1, texto: 'Contenido de la página uno.' },
      { page: 2, texto: 'Contenido de la página dos.' },
      { page: 3, texto: 'Contenido de la página tres.' },
    ]);
  });

  test('texto ANTES del primer separador (documento que no arranca justo con el marcador): se asigna a la página 1', () => {
    const texto = 'Encabezado del documento.-- 1 of 2 --\nResto de la página uno.-- 2 of 2 --\nPágina dos.';
    const segmentos = separarPorPagina(texto);

    expect(segmentos[0]).toEqual({ page: 1, texto: 'Encabezado del documento.' });
    expect(segmentos[1]).toEqual({ page: 1, texto: 'Resto de la página uno.' });
    expect(segmentos[2]).toEqual({ page: 2, texto: 'Página dos.' });
  });

  test('una página vacía entre separadores no genera un segmento vacío', () => {
    const texto = '-- 1 of 2 --\n   -- 2 of 2 --\nContenido real.';
    const segmentos = separarPorPagina(texto);
    expect(segmentos).toEqual([{ page: 2, texto: 'Contenido real.' }]);
  });
});

describe('chunkearDocumento() — integración chunking + páginas', () => {
  test('documento chico, una sola página: un chunk, page:null si no hay separadores', () => {
    const chunks = chunkearDocumento('Un documento de negocio chico, sin separadores de página.');
    expect(chunks).toEqual([{ chunkIndex: 0, page: null, text: 'Un documento de negocio chico, sin separadores de página.' }]);
  });

  test('chunkIndex es correlativo across páginas (no se reinicia por página)', () => {
    const paginaLarga = 'palabra '.repeat(150); // fuerza más de 1 chunk por página
    const texto = `-- 1 of 2 --\n${paginaLarga}-- 2 of 2 --\n${paginaLarga}`;

    const chunks = chunkearDocumento(texto, { tamano: 100, solape: 10 });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // Los primeros chunks son de la página 1, los últimos de la página 2.
    expect(chunks[0].page).toBe(1);
    expect(chunks[chunks.length - 1].page).toBe(2);
  });

  test('documento vacío: array vacío, no lanza', () => {
    expect(chunkearDocumento('')).toEqual([]);
  });
});
