import { puedeEscribirEn, type ScopeDim } from './data-scope.service';

/**
 * `[RE.89]` `puedeEscribirEn` es `ScopeService.canWrite` del servidor, del lado de la pantalla. Si se
 * separan, la pantalla vuelve a ofrecer lo que el servidor rechaza con 403 (o esconde lo que sí acepta).
 */
const dim = (o: Partial<ScopeDim>): ScopeDim => ({ mode: 'all', modeWrite: 'all', source: 'role', options: [], ...o });

describe('[RE.89] puedeEscribirEn — dónde escribe, igual que el servidor', () => {
  it('direccion: ve las 9 y no escribe en ninguna (el caso que lo abrió)', () => {
    const direccion = dim({ mode: 'all', modeWrite: 'none', valuesWrite: [] });
    for (const s of ['00', '01', '06', '08']) expect(puedeEscribirEn(direccion, s)).toBe(false);
  });

  it('all escribe en cualquiera; none en ninguna, aunque traiga valores', () => {
    expect(puedeEscribirEn(dim({ modeWrite: 'all' }), '03')).toBe(true);
    expect(puedeEscribirEn(dim({ modeWrite: 'none', valuesWrite: ['03'] }), '03')).toBe(false);
  });

  it('own y listed: sólo en las que el servidor resolvió para escritura', () => {
    const own = dim({ mode: 'own', modeWrite: 'own', valuesWrite: ['06'] });
    expect(puedeEscribirEn(own, '06')).toBe(true);
    expect(puedeEscribirEn(own, '08')).toBe(false);
    // Ve tres y escribe en una: es lo que `mode_write` permite, y se mira la lista de ESCRITURA.
    const listed = dim({ mode: 'listed', modeWrite: 'listed', options: [{ value: '01', label: '' }, { value: '02', label: '' }], valuesWrite: ['01'] });
    expect(puedeEscribirEn(listed, '01')).toBe(true);
    expect(puedeEscribirEn(listed, '02')).toBe(false);
  });

  it('listed sin lista no escribe (no se rellena con nada)', () => {
    expect(puedeEscribirEn(dim({ modeWrite: 'listed' }), '01')).toBe(false);
  });

  it('sin respuesta del alcance es «no se sabe», no «no puede»', () => {
    expect(puedeEscribirEn(null, '01')).toBeNull();
    expect(puedeEscribirEn(undefined, '01')).toBeNull();
  });
});
