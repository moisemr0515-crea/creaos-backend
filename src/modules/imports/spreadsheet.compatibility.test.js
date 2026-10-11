const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

const workbookBuffer = (bookType, sheets) => {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  });
  return XLSX.write(workbook, { type: 'buffer', bookType });
};

const firstSheetRows = (buffer) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: false,
  });
};

describe('contrato de compatibilidad SheetJS para imports CREA OS', () => {
  test.each(['xlsx', 'biff8'])('lee y escribe %s con UTF-8, números, fechas, vacíos y fórmulas cacheadas', (bookType) => {
    const buffer = workbookBuffer(bookType, [{
      name: 'Datos',
      rows: [
        ['Nombre', 'Monto', 'Fecha', 'Vacío', 'Fórmula'],
        ['María Ñandú', 1250.5, new Date(Date.UTC(2026, 9, 11)), '', { f: 'B2*2', v: 2501, t: 'n' }],
      ],
    }]);

    const rows = firstSheetRows(buffer);
    expect(rows[0]).toEqual(['Nombre', 'Monto', 'Fecha', 'Vacío', 'Fórmula']);
    expect(rows[1][0]).toBe('María Ñandú');
    expect(rows[1][1]).toBe('1250.5');
    expect(rows[1][2]).not.toBe('');
    expect(rows[1][3]).toBe('');
    expect(rows[1][4]).toBe('2501');
  });

  test('conserva CSV UTF-8 mediante el parser actual de los imports', () => {
    const rows = parse(Buffer.from('Nombre,Monto\nJosé Álvarez,42\n', 'utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    expect(rows).toEqual([{ Nombre: 'José Álvarez', Monto: '42' }]);
  });

  test('mantiene el contrato actual de usar únicamente la primera hoja', () => {
    const buffer = workbookBuffer('xlsx', [
      { name: 'Primera', rows: [['sku'], ['PRIMERO']] },
      { name: 'Segunda', rows: [['sku'], ['SEGUNDO']] },
    ]);
    expect(firstSheetRows(buffer)).toEqual([['sku'], ['PRIMERO']]);
  });

  test('procesa 5000 filas, límite máximo actual de importación de productos', () => {
    const rows = [['sku', 'nombre']];
    for (let index = 0; index < 5000; index += 1) rows.push([`SKU-${index}`, `Producto ${index}`]);
    const buffer = workbookBuffer('xlsx', [{ name: 'Productos', rows }]);
    expect(buffer.length).toBeLessThan(5 * 1024 * 1024);
    expect(firstSheetRows(buffer)).toHaveLength(5001);
  });

  test('rechaza un contenedor XLSX corrupto en vez de producir filas', () => {
    const corrupt = Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Buffer.from('OOXML corrupto')]);
    expect(() => firstSheetRows(corrupt)).toThrow();
  });
});
