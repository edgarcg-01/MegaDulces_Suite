import { esProponible, glosaVecinal, refVecinal, VEREDICTO_EN_CURSO } from './caja-vecinal.query';

/**
 * `[CGP-VEC.1]` La regla de qué cierre de ruta vecinal entra a la bandeja.
 *
 * Los casos salen de lo medido en prod el 2026-10-15 sobre
 * `analytics.v_vecinal_conciliacion`: 8 rutas en 6 sucursales, y desde el 12-oct **19 días que
 * ninguna captura tocó**.
 */
describe('[CGP-VEC.1] qué cierre de ruta vecinal se propone', () => {
  const dia = (o: Partial<{ cerrado: boolean | null; veredicto: string | null; monto: number }> = {}) => ({
    cerrado: true, veredicto: 'cuadra', monto: 6244.48, ...o,
  });

  it('un día cerrado que cuadra se propone', () => {
    expect(esProponible(dia())).toBe(true);
  });

  /**
   * ⛔ **La trampa que justifica que la regla no mire sólo `cerrado`.** Medido el 2026-10-15: las
   * tres filas de HOY vienen con `cerrado = true` y veredicto `dia_en_curso`. Con la regla ingenua,
   * la bandeja ofrecería capturar un conteo que todavía se está moviendo.
   */
  it('⛔ el día EN CURSO no se propone, aunque venga marcado como cerrado', () => {
    expect(esProponible(dia({ veredicto: VEREDICTO_EN_CURSO }))).toBe(false);
  });

  it('un día sin cerrar no se propone', () => {
    expect(esProponible(dia({ cerrado: false }))).toBe(false);
    expect(esProponible(dia({ cerrado: null }))).toBe(false);
  });

  /**
   * ⚠️ El efectivo se contó igual: esconderlo sería perder dinero real de la vista. Lo que NO se
   * hace es dibujarlo como si cuadrara — por eso el veredicto viaja con él (ADR-056).
   */
  it('un día con faltante o con exceso SÍ se propone: el efectivo existe', () => {
    expect(esProponible(dia({ veredicto: 'faltante' }))).toBe(true);
    expect(esProponible(dia({ veredicto: 'vecinal_excede_arqueo' }))).toBe(true);
  });

  it('sin efectivo contado no hay nada que capturar', () => {
    expect(esProponible(dia({ monto: 0 }))).toBe(false);
  });

  /**
   * ⚠️ La caja va en la llave porque una sucursal cierra más de una el mismo día: la `07` cerraba
   * en la 4 y el 15-oct estaba timbrando en la 3. Sin la caja, los dos cierres colapsan en uno
   * y el segundo desaparece de la bandeja para siempre.
   */
  it('la llave distingue dos cajas del mismo día', () => {
    expect(refVecinal('08', '2026-10-07', 8)).toBe('08|VEC|2026-10-07|8');
    expect(refVecinal('07', '2026-10-15', 4)).not.toBe(refVecinal('07', '2026-10-15', 3));
  });

  it('la glosa nombra la ruta y el día, y sólo grita cuando no cuadra', () => {
    expect(glosaVecinal('2V005', '2026-10-07', 'cuadra')).toBe('Ruta vecinal 2V005 · cierre del 2026-10-07');
    expect(glosaVecinal('2V001,2V003', '2026-10-13', 'faltante'))
      .toBe('Ruta vecinal 2V001,2V003 · cierre del 2026-10-13 · faltante');
  });
});
