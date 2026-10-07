import { fechaValida, resolverPeriodo, sumarDias } from './report-period';

/**
 * `[MS.3.5]` El periodo del reporte. Lo que se defiende: una fecha imposible NO se «corrige» en silencio (el 31 de
 * febrero no es el 3 de marzo), el orden y el tope se validan, y sin parámetros son los últimos 30 días contando hoy.
 */
const HOY = '2026-10-06';

describe('MS.3.5 · fechaValida', () => {
  it('acepta fechas reales, incluido el 29 de febrero bisiesto', () => {
    expect(fechaValida('2026-10-06')).toBe(true);
    expect(fechaValida('2028-02-29')).toBe(true);
  });
  it('⛔ NEGATIVA — rechaza lo imposible y lo mal formado', () => {
    expect(fechaValida('2026-02-31')).toBe(false);
    expect(fechaValida('2027-02-29')).toBe(false);
    expect(fechaValida('2026-13-01')).toBe(false);
    expect(fechaValida('06/10/2026')).toBe(false);
    expect(fechaValida('2026-10-6')).toBe(false);
    expect(fechaValida('')).toBe(false);
    expect(fechaValida(undefined)).toBe(false);
    expect(fechaValida(20261006)).toBe(false);
  });
});

describe('MS.3.5 · resolverPeriodo', () => {
  it('sin parámetros: los últimos 30 días contando hoy', () => {
    expect(resolverPeriodo(undefined, undefined, HOY)).toEqual({ ok: true, desde: '2026-09-07', hasta: '2026-10-06' });
  });
  it('sólo `hasta`: 30 días hacia atrás desde ahí', () => {
    expect(resolverPeriodo(undefined, '2026-09-30', HOY)).toEqual({ ok: true, desde: '2026-09-01', hasta: '2026-09-30' });
  });
  it('un día solo es válido', () => {
    expect(resolverPeriodo('2026-10-06', '2026-10-06', HOY)).toEqual({ ok: true, desde: '2026-10-06', hasta: '2026-10-06' });
  });
  it('⛔ desde posterior a hasta → rechazo con motivo', () => {
    expect(resolverPeriodo('2026-10-07', '2026-10-06', HOY)).toMatchObject({ ok: false, motivo: expect.stringContaining('posterior') });
  });
  it('⛔ fechas imposibles → rechazo, no se corrigen', () => {
    expect(resolverPeriodo('2026-02-31', '2026-03-05', HOY)).toMatchObject({ ok: false });
    expect(resolverPeriodo('2026-03-01', 'ayer', HOY)).toMatchObject({ ok: false });
  });
  it('⭐ el tope es de 366 días: 366 pasa, 367 no', () => {
    expect(resolverPeriodo('2025-10-06', '2026-10-06', HOY)).toMatchObject({ ok: true }); // 366 días contando ambos
    expect(resolverPeriodo('2025-10-05', '2026-10-06', HOY)).toMatchObject({ ok: false, motivo: expect.stringContaining('366') });
  });
});

describe('MS.3.5 · sumarDias', () => {
  it('cruza mes y año', () => {
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
  });
});
