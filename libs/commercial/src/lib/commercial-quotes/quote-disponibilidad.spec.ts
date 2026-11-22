import { disponibilidadAlCotizar } from './quote-disponibilidad';

/**
 * `[COT.51]` La existencia al cotizar. Los casos salen de renglones reales de prod (2026-11-22):
 * la existencia viene en piezas (base) y el renglón en cajas.
 */
describe('[COT.51] disponibilidadAlCotizar', () => {
  it('1 caja de 24 contra 1,423 piezas: alcanza', () => {
    expect(disponibilidadAlCotizar('available', 1423, 1, 24)).toBe('available');
  });

  it('⭐ 1 caja de 50 contra 3 piezas: alcanza EN PARTE (comparar 1 contra 3 diría que sobra)', () => {
    expect(disponibilidadAlCotizar('available', 3, 1, 50)).toBe('partial');
  });

  it('2 cajas de 32 contra 31 piezas: en parte; justo lo requerido, alcanza', () => {
    expect(disponibilidadAlCotizar('available', 31, 2, 32)).toBe('partial');
    expect(disponibilidadAlCotizar('available', 64, 2, 32)).toBe('available');
  });

  it('sin factor el renglón está en la base: 5 contra 4 es en parte', () => {
    expect(disponibilidadAlCotizar('available', 4, 5, null)).toBe('partial');
    expect(disponibilidadAlCotizar('available', 158.25, 25, null)).toBe('available'); // kilos
  });

  it('cero o negativa (Kepler deja negativos): no hay', () => {
    expect(disponibilidadAlCotizar('available', 0, 1, 24)).toBe('unavailable');
    expect(disponibilidadAlCotizar('available', -12, 1, null)).toBe('unavailable');
  });

  it('⭐ sin dato de existencia NO es cero: se declara desconocida', () => {
    expect(disponibilidadAlCotizar('available', null, 1, 48)).toBe('unknown');
    expect(disponibilidadAlCotizar('available', Number.NaN, 1, 48)).toBe('unknown');
  });

  it('el regalo sin factor declarado: sólo se puede afirmar «no hay»', () => {
    expect(disponibilidadAlCotizar('available', 0, 1, 'desconocido')).toBe('unavailable');
    expect(disponibilidadAlCotizar('available', 500, 1, 'desconocido')).toBe('unknown');
  });

  it('lo que el motor ya juzgó por otra razón (sin precio, no casó) se conserva', () => {
    expect(disponibilidadAlCotizar('unavailable', 900, 1, null)).toBe('unavailable');
    expect(disponibilidadAlCotizar('not_carried', null, 1, null)).toBe('not_carried');
    expect(disponibilidadAlCotizar('unmatched', null, 1, null)).toBe('unmatched');
  });
});
