import { diasDesde, esAnterior, fechaMexico, hoyMexico } from './dia-mx';

/**
 * `[WMS-REC.18]` El día de México. La trampa que se cuida es la de siempre en este repo: a las 7 de
 * la noche de México ya es el día siguiente en UTC. Si el Andén usara el día UTC, los vales de hoy
 * se irían al grupo de "días anteriores" toda la tarde.
 */
describe('[WMS-REC.18] el día en hora de México', () => {
  it('a las 19:30 de México sigue siendo hoy, aunque en UTC ya sea mañana', () => {
    // 2026-10-08T01:30Z = 2026-10-07 19:30 en México.
    expect(hoyMexico(new Date('2026-10-08T01:30:00Z'))).toBe('2026-10-07');
  });

  it('una fecha de documento pasa tal cual; un instante se lleva al día de México', () => {
    expect(fechaMexico('2026-10-06')).toBe('2026-10-06');
    expect(fechaMexico('2026-10-08T01:30:00.000Z')).toBe('2026-10-07');
    expect(fechaMexico(null)).toBeNull();
    expect(fechaMexico('no es fecha')).toBeNull();
  });

  it('cuenta los días hacia atrás, y lo de mañana sale negativo', () => {
    expect(diasDesde('2026-10-07', '2026-10-07')).toBe(0);
    expect(diasDesde('2026-10-06', '2026-10-07')).toBe(1);
    expect(diasDesde('2026-09-30', '2026-10-07')).toBe(7);
    expect(diasDesde('2026-10-08', '2026-10-07')).toBe(-1);
  });

  it('sólo lo de días ANTERIORES cuenta como atrasado', () => {
    expect(esAnterior('2026-10-06', '2026-10-07')).toBe(true);
    expect(esAnterior('2026-10-07', '2026-10-07')).toBe(false);
    // Kepler adelanta documentos: lo de mañana no se mete al grupo de atrasados.
    expect(esAnterior('2026-10-08', '2026-10-07')).toBe(false);
    expect(esAnterior(null, '2026-10-07')).toBe(false);
  });
});
