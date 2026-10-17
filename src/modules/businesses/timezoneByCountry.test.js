// Zona horaria por defecto derivada del país: función pura, universal y sin casos por tenant. Solo aplica al CREAR un negocio.
const { zonaHorariaPorPais, ZONA_POR_PAIS } = require('./timezoneByCountry');
const { esZonaValida } = require('../../utils/timezone');
const Business = require('./business.model');

describe('zonaHorariaPorPais (pura)', () => {
  test.each([
    ['PE', 'America/Lima'], ['MX', 'America/Mexico_City'], ['CO', 'America/Bogota'], ['AR', 'America/Argentina/Buenos_Aires'],
    ['pe', 'America/Lima'], [' mx ', 'America/Mexico_City'],
  ])('%s → %s', (pais, zona) => expect(zonaHorariaPorPais(pais)).toBe(zona));

  test.each([[undefined], [null], [''], ['  '], ['ZZ'], ['CL'], ['US'], [123], [{}]])('país no reconocido o con varias zonas (%p) → null (sin zona inventada)', (pais) => {
    expect(zonaHorariaPorPais(pais)).toBeNull();
  });

  test('toda zona de la tabla es una zona IANA válida', () => {
    Object.values(ZONA_POR_PAIS).forEach((zona) => expect(esZonaValida(zona)).toBe(true));
  });
});

describe('Business.settings.timezone — default derivado del país (sin base de datos)', () => {
  test('un negocio nuevo solo con nombre: país PE ⇒ America/Lima (antes America/Mexico_City para todos)', () => {
    expect(new Business({ name: 'Negocio de prueba' }).settings.timezone).toBe('America/Lima');
  });

  test('con otro país explícito la zona sigue a ese país', () => {
    expect(new Business({ name: 'MX', country: 'MX' }).settings.timezone).toBe('America/Mexico_City');
    expect(new Business({ name: 'CO', country: 'CO' }).settings.timezone).toBe('America/Bogota');
  });

  test('país fuera de la tabla ⇒ sin zona (null): no se inventa Ciudad de México', () => {
    expect(new Business({ name: 'CL', country: 'CL' }).settings.timezone).toBeNull();
  });

  test('una zona explícita siempre se respeta (también para un documento ya guardado: el default no se reaplica)', () => {
    expect(new Business({ name: 'N', country: 'PE', settings: { timezone: 'America/Mexico_City' } }).settings.timezone).toBe('America/Mexico_City');
  });
});
