const { esZonaValida, partesEnZona, inicioDelDiaEnZona } = require('./timezone');

describe('inicioDelDiaEnZona — 00:00 del día en la zona del negocio, como instante UTC', () => {
  test('Lima (UTC-5, sin horario de verano): el 1 de octubre empieza a las 05:00 UTC', () => {
    expect(inicioDelDiaEnZona(2026, 10, 1, 'America/Lima').toISOString()).toBe('2026-10-01T05:00:00.000Z');
  });

  test('Ciudad de México (UTC-6) y Bogotá (UTC-5)', () => {
    expect(inicioDelDiaEnZona(2026, 10, 1, 'America/Mexico_City').toISOString()).toBe('2026-10-01T06:00:00.000Z');
    expect(inicioDelDiaEnZona(2026, 10, 1, 'America/Bogota').toISOString()).toBe('2026-10-01T05:00:00.000Z');
  });

  test('UTC es la identidad', () => {
    expect(inicioDelDiaEnZona(2026, 10, 1, 'UTC').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  test('una zona con horario de verano ajusta el desfase de ESE día (Nueva York, marzo de 2026)', () => {
    expect(inicioDelDiaEnZona(2026, 3, 8, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z'); // aún UTC-5
    expect(inicioDelDiaEnZona(2026, 3, 9, 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z'); // ya UTC-4
  });

  test('mes y día desbordados pasan al siguiente: mes 13 = enero; día 32 = día 1 del mes siguiente', () => {
    expect(inicioDelDiaEnZona(2026, 13, 1, 'America/Lima').toISOString()).toBe('2027-01-01T05:00:00.000Z');
    expect(inicioDelDiaEnZona(2026, 1, 32, 'America/Lima').toISOString()).toBe('2026-02-01T05:00:00.000Z');
    expect(inicioDelDiaEnZona(2026, 0, 1, 'America/Lima').toISOString()).toBe('2025-12-01T05:00:00.000Z');
  });
});

describe('partesEnZona / esZonaValida', () => {
  test('el mismo instante es otro día en otra zona: 04:30Z del 1 de octubre sigue siendo 30 de septiembre en Lima', () => {
    const instante = new Date('2026-10-01T04:30:00Z');
    expect(partesEnZona(instante, 'America/Lima')).toMatchObject({ year: 2026, month: 9, day: 30, hour: 23, minute: 30 });
    expect(partesEnZona(instante, 'UTC')).toMatchObject({ year: 2026, month: 10, day: 1, hour: 4 });
  });

  test('medianoche exacta no sale como hora 24', () => {
    expect(partesEnZona(new Date('2026-10-01T05:00:00Z'), 'America/Lima')).toMatchObject({ month: 10, day: 1, hour: 0 });
  });

  test('esZonaValida', () => {
    expect(esZonaValida('America/Lima')).toBe(true);
    for (const mala of ['Lima', 'Marte/Olympus', '', '  ', null, undefined, 5]) expect(esZonaValida(mala)).toBe(false);
  });
});
