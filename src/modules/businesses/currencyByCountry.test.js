// Moneda por defecto derivada del país: función pura, universal y sin casos por tenant.
const { monedaPorPais, MONEDA_POR_PAIS, MONEDA_DE_REFERENCIA } = require('./currencyByCountry');
const Business = require('./business.model');

describe('monedaPorPais (pura)', () => {
  test.each([
    ['PE', 'PEN'], ['MX', 'MXN'], ['CO', 'COP'], ['AR', 'ARS'], ['US', 'USD'], ['EC', 'USD'],
    ['pe', 'PEN'], [' mx ', 'MXN'],
  ])('%s → %s', (pais, moneda) => expect(monedaPorPais(pais)).toBe(moneda));

  test.each([[undefined], [null], [''], ['  '], ['ZZ'], ['CL'], [123], [{}]])('país no reconocido (%p) → moneda de referencia', (pais) => {
    expect(monedaPorPais(pais)).toBe(MONEDA_DE_REFERENCIA);
  });

  test('solo devuelve monedas que el selector de «Mi negocio» sabe mostrar', () => {
    const selector = ['PEN', 'USD', 'MXN', 'ARS', 'COP'];
    Object.values(MONEDA_POR_PAIS).concat(MONEDA_DE_REFERENCIA).forEach((m) => expect(selector).toContain(m));
  });
});

describe('Business.currency — default derivado del país (sin base de datos)', () => {
  test('un negocio nuevo solo con nombre: país PE ⇒ PEN (antes MXN para todos)', () => {
    const negocio = new Business({ name: 'Negocio de prueba' });
    expect(negocio.country).toBe('PE');
    expect(negocio.currency).toBe('PEN');
  });

  test('con otro país explícito la moneda sigue a ese país', () => {
    expect(new Business({ name: 'Negocio MX', country: 'MX' }).currency).toBe('MXN');
    expect(new Business({ name: 'Negocio CO', country: 'CO' }).currency).toBe('COP');
    expect(new Business({ name: 'Negocio US', country: 'US' }).currency).toBe('USD');
  });

  test('país fuera de la tabla ⇒ moneda de referencia', () => {
    expect(new Business({ name: 'Negocio CL', country: 'CL' }).currency).toBe('USD');
  });

  test('una moneda explícita siempre se respeta (y se normaliza a mayúsculas)', () => {
    expect(new Business({ name: 'Negocio', country: 'PE', currency: 'mxn' }).currency).toBe('MXN');
    expect(new Business({ name: 'Negocio', currency: 'ars' }).currency).toBe('ARS');
  });
});
