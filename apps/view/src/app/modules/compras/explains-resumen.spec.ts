import { explainsResumen } from './explains-resumen';

describe('explainsResumen — [RE.81] lo exacto no se cuenta como candidato', () => {
  it('la entrada 0000545: una nota exacta y una candidata', () => {
    expect(explainsResumen([{ match: 'exacto' }, { match: 'proveedor+fecha' }])).toBe('1 exacto · 1 candidato');
  });

  it('el que casa por monto también es candidato (no está ligado por Kepler)', () => {
    expect(explainsResumen([{ match: 'monto' }, { match: 'proveedor+fecha' }, { match: 'proveedor+fecha' }])).toBe('3 candidatos');
  });

  it('sólo exactos', () => {
    expect(explainsResumen([{ match: 'exacto' }, { match: 'exacto' }])).toBe('2 exactos');
  });

  it('sin filas no dice nada', () => {
    expect(explainsResumen([])).toBe('');
  });
});
