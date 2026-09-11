const { escapeRegex } = require('./regex');

describe('utils/regex#escapeRegex()', () => {
  test('deja intacto un string sin caracteres especiales', () => {
    expect(escapeRegex('922800127')).toBe('922800127');
  });

  test('escapa cada caracter especial de regex', () => {
    expect(escapeRegex('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o'
    );
  });

  test('el resultado escapado matchea el string original de forma literal, no como patrón', () => {
    const input = '1.2*3';
    const regex = new RegExp(escapeRegex(input));
    expect(regex.test('1.2*3')).toBe(true);
    expect(regex.test('1x2yyy3')).toBe(false); // si NO estuviera escapado, "." y "*" matchearían esto
  });

  test('un input armado para ReDoS no rompe ni cuelga — queda como literal inerte', () => {
    const maliciosa = '(a+)+$'.repeat(5);
    expect(() => new RegExp(escapeRegex(maliciosa))).not.toThrow();
    // Como literal, no matchea nada parecido a un string real de búsqueda.
    expect(new RegExp(escapeRegex(maliciosa)).test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false);
  });
});
