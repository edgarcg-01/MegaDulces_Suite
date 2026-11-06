import { coincideOc, origenOc } from './oc-abiertas-filtros';

/** `[PQ.84]` Encontrar UNA orden: por folio, por la requisición de la que salió y por proveedor. */
const oc = (folio: string, proveedor: string | null, requisicion: { id: string | null; folio: string | null; kepler: string | null } | null) =>
  ({ folio, proveedor, requisicion });
const EFFEM = oc('0007296', 'EFFEM MEXICO INC. Y COMPAÑÍAS EN N.C DE CV', { id: 'r1', folio: 'RQ-2026-02055', kepler: '0003143' });
const LICO = oc('0000092', 'DULCES LICO', null);

describe('[PQ.84] coincideOc', () => {
  it('por el final del folio de la OC, con o sin ceros', () => {
    expect(coincideOc(EFFEM, '7296')).toBe(true);
    expect(coincideOc(EFFEM, '0007296')).toBe(true);
    expect(coincideOc(LICO, '92')).toBe(true);
  });
  it('por la requisición de la que salió: la de la Suite o la de Kepler', () => {
    expect(coincideOc(EFFEM, '2055')).toBe(true);          // RQ-2026-02055
    expect(coincideOc(EFFEM, '3143')).toBe(true);          // requisición 0003143 de Kepler
    expect(coincideOc(EFFEM, 'rq-2026-02055')).toBe(true);
  });
  it('por proveedor, sin acentos ni mayúsculas', () => {
    expect(coincideOc(EFFEM, 'effem')).toBe(true);
    expect(coincideOc(EFFEM, 'compañias')).toBe(true);
    expect(coincideOc(LICO, 'lico')).toBe(true);
  });
  it('⛔ control: lo que no está, no coincide (ni un número que sólo aparece en MEDIO del folio)', () => {
    expect(coincideOc(EFFEM, '9999')).toBe(false);
    expect(coincideOc(EFFEM, '729')).toBe(false);          // 0007296 no TERMINA en 729
    expect(coincideOc(LICO, 'effem')).toBe(false);
    expect(coincideOc(LICO, '2055')).toBe(false);
  });
  it('vacío = todas', () => {
    expect(coincideOc(LICO, '  ')).toBe(true);
  });
});

describe('[PQ.84] origenOc', () => {
  it('Suite si trae RQ; Kepler si sólo trae la requisición de Kepler; si no, sin requisición', () => {
    expect(origenOc(EFFEM)).toBe('suite');
    expect(origenOc(oc('1', null, { id: null, folio: null, kepler: '0003143' }))).toBe('kepler');
    expect(origenOc(LICO)).toBe('sin');
  });
});
