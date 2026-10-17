const { resolverPeriodo } = require('./stats.period');

const LIMA = 'America/Lima';
const iso = (d) => d.toISOString();

describe('resolverPeriodo — bordes de mes en la zona horaria del negocio', () => {
  test('this_month en Lima: septiembre acaba a las 05:00Z del 1 de octubre, no a las 00:00Z', () => {
    // 04:00Z del 1 de octubre = 23:00 del 30 de septiembre en Lima → todavía es septiembre.
    const p = resolverPeriodo({ period: 'this_month' }, LIMA, new Date('2026-10-01T04:00:00Z'));
    expect(iso(p.desde)).toBe('2026-09-01T05:00:00.000Z');
    expect(iso(p.hasta)).toBe('2026-10-01T05:00:00.000Z');
    expect(iso(p.anterior.desde)).toBe('2026-08-01T05:00:00.000Z');
    expect(iso(p.anterior.hasta)).toBe('2026-09-01T05:00:00.000Z');
  });

  test('un minuto después del cambio de mes en Lima ya es octubre', () => {
    const p = resolverPeriodo({ period: 'this_month' }, LIMA, new Date('2026-10-01T05:00:00Z'));
    expect(iso(p.desde)).toBe('2026-10-01T05:00:00.000Z');
    expect(iso(p.hasta)).toBe('2026-11-01T05:00:00.000Z');
  });

  test('el mismo instante en UTC cae en otro mes (por eso importa la zona)', () => {
    const p = resolverPeriodo({ period: 'this_month' }, 'UTC', new Date('2026-10-01T04:00:00Z'));
    expect(iso(p.desde)).toBe('2026-10-01T00:00:00.000Z');
  });

  test('last_month: el mes de calendario anterior, y su anterior es el de antes', () => {
    const p = resolverPeriodo({ period: 'last_month' }, LIMA, new Date('2026-10-17T15:00:00Z'));
    expect(p.key).toBe('last_month');
    expect(iso(p.desde)).toBe('2026-09-01T05:00:00.000Z');
    expect(iso(p.hasta)).toBe('2026-10-01T05:00:00.000Z');
    expect(iso(p.anterior.desde)).toBe('2026-08-01T05:00:00.000Z');
  });

  test('cambio de año: en enero, el mes anterior es diciembre del año pasado', () => {
    const p = resolverPeriodo({ period: 'last_month' }, LIMA, new Date('2026-01-15T12:00:00Z'));
    expect(iso(p.desde)).toBe('2025-12-01T05:00:00.000Z');
    expect(iso(p.hasta)).toBe('2026-01-01T05:00:00.000Z');
    const diciembre = resolverPeriodo({ period: 'this_month' }, LIMA, new Date('2026-12-31T23:00:00Z'));
    expect(iso(diciembre.hasta)).toBe('2027-01-01T05:00:00.000Z');
  });

  test('por defecto es this_month', () => {
    expect(resolverPeriodo({}, LIMA, new Date('2026-10-17T15:00:00Z')).key).toBe('this_month');
  });
});

describe('resolverPeriodo — personalizado', () => {
  test('from y to se incluyen enteros: el rango acaba al empezar el día siguiente a "to"', () => {
    const p = resolverPeriodo({ period: 'custom', from: '2026-10-01', to: '2026-10-10' }, LIMA, new Date('2026-10-17T15:00:00Z'));
    expect(iso(p.desde)).toBe('2026-10-01T05:00:00.000Z');
    expect(iso(p.hasta)).toBe('2026-10-11T05:00:00.000Z');
  });

  test('el periodo anterior es el tramo de la misma duración justo antes', () => {
    const p = resolverPeriodo({ period: 'custom', from: '2026-10-11', to: '2026-10-20' }, LIMA, new Date('2026-10-30T15:00:00Z'));
    expect(iso(p.anterior.desde)).toBe('2026-10-01T05:00:00.000Z');
    expect(iso(p.anterior.hasta)).toBe('2026-10-11T05:00:00.000Z');
  });

  test('un solo día: from = to', () => {
    const p = resolverPeriodo({ period: 'custom', from: '2026-10-05', to: '2026-10-05' }, LIMA, new Date('2026-10-17T15:00:00Z'));
    expect(p.hasta - p.desde).toBe(24 * 60 * 60 * 1000);
  });

  test.each([
    [{ period: 'custom', from: '2026-10-10', to: '2026-10-01' }, /posterior/],
    [{ period: 'custom', from: '10/10/2026', to: '2026-10-11' }, /AAAA-MM-DD/],
    [{ period: 'custom', from: '2026-02-31', to: '2026-03-01' }, /fecha real/],
    [{ period: 'custom', from: '2026-10-01' }, /"to"/],
    [{ period: 'custom', to: '2026-10-01' }, /"from"/],
    [{ period: 'custom', from: '2024-01-01', to: '2026-10-01' }, /366/],
    [{ period: 'semana' }, /this_month, last_month o custom/],
  ])('%j → 400', (query, mensaje) => {
    expect(() => resolverPeriodo(query, LIMA, new Date('2026-10-17T15:00:00Z'))).toThrow(mensaje);
    try {
      resolverPeriodo(query, LIMA, new Date('2026-10-17T15:00:00Z'));
    } catch (e) {
      expect(e.statusCode).toBe(400);
    }
  });

  test('exactamente 366 días se acepta', () => {
    expect(() => resolverPeriodo({ period: 'custom', from: '2026-01-01', to: '2026-12-31' }, LIMA)).not.toThrow();
  });
});
