import { FOLIO_RE, formatFolio, parseFolio } from './folio';

describe('folio SRV-AAAA-NNNNN', () => {
  it('arma el folio con el consecutivo a 5 dígitos', () => {
    expect(formatFolio(2026, 1)).toBe('SRV-2026-00001');
    expect(formatFolio(2026, 12345)).toBe('SRV-2026-12345');
    expect(formatFolio(2026, 99999)).toBe('SRV-2026-99999');
  });
  it('NEGATIVA: año o consecutivo fuera de rango', () => {
    expect(() => formatFolio(1999, 1)).toThrow();
    expect(() => formatFolio(2026, 0)).toThrow();
    expect(() => formatFolio(2026, 100000)).toThrow();
    expect(() => formatFolio(2026, 1.5)).toThrow();
  });
  it('lo que arma pasa el mismo patrón que exige el CHECK de la base', () => {
    for (const n of [1, 9, 10, 99999]) expect(FOLIO_RE.test(formatFolio(2026, n))).toBe(true);
    // El CHECK es `^SRV-[0-9]{4}-[0-9]{5}$`: el patrón debe ser el mismo.
    expect(FOLIO_RE.source).toBe('^SRV-(\\d{4})-(\\d{5})$');
  });
  it('parseFolio es la inversa', () => {
    expect(parseFolio('SRV-2026-00042')).toEqual({ year: 2026, numero: 42 });
    expect(parseFolio(' srv-2026-00042 ')).toEqual({ year: 2026, numero: 42 });
  });
  it('NEGATIVA: no confunde el folio de la tienda (MD-2026-00012) con el de la mesa', () => {
    expect(parseFolio('MD-2026-00012')).toBeNull();
    expect(parseFolio('SRV-26-1')).toBeNull();
    expect(parseFolio('')).toBeNull();
  });
});
