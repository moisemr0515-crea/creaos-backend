const { formatearImporte, normalizarMoneda } = require('./money');

describe('formatearImporte — único formateador de importes del backend', () => {
  test.each([
    [500, 'PEN', '500 PEN'],
    [500, 'pen', '500 PEN'],
    [500, ' mxn ', '500 MXN'],
    ['1200', 'COP', '1200 COP'],
    [0, 'PEN', '0 PEN'],
    [12.5, 'USD', '12.5 USD'],
  ])('%p + %p → %p', (valor, moneda, esperado) => expect(formatearImporte(valor, moneda)).toBe(esperado));

  test('sin moneda válida no inventa ninguna: solo el número', () => {
    for (const moneda of [null, undefined, '', '  ', 'PE', 'PENN', '12A', 5]) {
      expect(formatearImporte(500, moneda)).toBe('500');
    }
  });

  test('sin valor numérico devuelve cadena vacía', () => {
    for (const valor of [null, undefined, '', 'abc', NaN, Infinity]) {
      expect(formatearImporte(valor, 'PEN')).toBe('');
    }
  });

  test('nunca produce el símbolo "$" ni "USD" a menos que la moneda del negocio sea USD', () => {
    expect(formatearImporte(500, 'PEN')).not.toMatch(/\$|USD/);
    expect(formatearImporte(500, null)).not.toMatch(/\$|USD/);
  });

  test('normalizarMoneda', () => {
    expect(normalizarMoneda('pen')).toBe('PEN');
    expect(normalizarMoneda('xx')).toBe('');
    expect(normalizarMoneda(null)).toBe('');
  });
});
