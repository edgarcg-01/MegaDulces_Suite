import { calcularCrecimiento, MIN_ENTITY_COVERAGE, MIN_PAIRED_PERIODS, type FilaReal } from './budget-growth-yoy.engine';

/**
 * `[PVI.12]` — **El crecimiento año-contra-año: la regla que gobierna $604,775,116 de meta.**
 *
 * Hasta acá su única cobertura era un smoke DB-direct contra producción. Ese smoke vale —cruza dos
 * implementaciones— pero verifica **lo que HAY**, no **lo que la regla HACE**: no puede construir
 * una entidad exactamente en el umbral, ni un periodo abierto, ni una base en cero. Son justo los
 * casos donde un motor de presupuesto se equivoca caro.
 *
 * ⭐ **La prueba negativa no hubo que inventarla.** El propio motor conserva el número VIEJO al
 * lado del nuevo (`cobertura.growth_pct_todo`, todas las entidades) porque las dos cifras contestan
 * preguntas distintas. O sea que cada caso compara la regla contra su predecesora **con el código
 * de producción**, no contra una copia retipeada que podría divergir.
 *
 * El escenario calca la forma del defecto real medido en prod el 2026-10-08: una entidad que vende
 * **1 de 9** periodos en el año base y el año entero en el reciente. En prod era `mostrador:03`
 * (8ESQ), pasó de $230,601 a $39,240,479 y aportaba **24.28 pp** de los 21.46 % que el canal
 * publicaba. Acá los montos son redondos para que la aritmética sea verificable a mano.
 */

const ABIERTO = 10;                 // periodos 1..9 cerrados; el 10 y los posteriores se excluyen
const Y0 = 2025, Y1 = 2026;

const fila = (entity_key: string, channel: string, year: number, period: number, monto: number): FilaReal =>
  ({ entity_key, channel, year, period, monto });

/** Una entidad que vende el mismo monto en cada periodo listado. */
function serie(entity_key: string, channel: string, year: number, periodos: number[], monto: number): FilaReal[] {
  return periodos.map((p) => fila(entity_key, channel, year, p, monto));
}

const P1_9 = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * `mostrador:01` es comparable (9 y 9 periodos): 9,000,000 → 9,900,000 = **+10 %**.
 * `mostrador:03` NO lo es (1 periodo en el año base): 1,000,000 → 9,000,000.
 * Juntas, el número viejo da **+89 %**; la entidad que no parea arrastra el canal 8.9×.
 */
const ESCENARIO: FilaReal[] = [
  ...serie('mostrador:01', 'mostrador', Y0, P1_9, 1_000_000),
  ...serie('mostrador:01', 'mostrador', Y1, P1_9, 1_100_000),
  ...serie('mostrador:03', 'mostrador', Y0, [1], 1_000_000),
  ...serie('mostrador:03', 'mostrador', Y1, P1_9, 1_000_000),
  ...serie('preventa:01', 'preventa', Y0, P1_9, 500_000),
  ...serie('preventa:01', 'preventa', Y1, P1_9, 500_000),
];

const correr = (rows: FilaReal[], over: Partial<Parameters<typeof calcularCrecimiento>[0]> = {}) =>
  calcularCrecimiento({ rows, abierto: ABIERTO, y0: Y0, y1: Y1, canales: ['mostrador', 'preventa'], defaultGrowth: 0.08, ...over });

describe('[PVI.12] una entidad parea sólo si vendió en los DOS años', () => {
  it('el umbral sale de los periodos CERRADOS, no de un número fijo', () => {
    // 9 cerrados × 0.8 = 7.2 → ceil = 8. Y nunca por debajo de MIN_PAIRED_PERIODS.
    expect(correr(ESCENARIO).min_periodos_entidad).toBe(Math.max(MIN_PAIRED_PERIODS, Math.ceil(9 * MIN_ENTITY_COVERAGE)));
    expect(correr(ESCENARIO).min_periodos_entidad).toBe(8);
  });

  it('⭐ la entidad con 1 de 9 periodos en el año base queda FUERA', () => {
    const cob = correr(ESCENARIO).by_channel['mostrador'].cobertura;
    expect(cob?.entidades_comparables).toBe(1);
    expect(cob?.entidades_excluidas).toBe(1);
    expect(cob?.excluido_monto_y1).toBe(9_000_000);   // el dinero que quedó fuera, declarado
  });

  it('⛔ PRUEBA NEGATIVA: el número VIEJO (todas las entidades) publica 8.9× el real', () => {
    const ch = correr(ESCENARIO).by_channel['mostrador'];
    expect(ch.growth_pct).toBe(0.1);                  // la regla nueva: +10 %
    expect(ch.cobertura?.growth_pct_todo).toBe(0.89); // la vieja: +89 %
    // ⭐ Las dos se publican juntas a propósito: ninguna es «la» verdad sin decir cuál se preguntó.
    expect(ch.growth_pct).not.toBe(ch.cobertura?.growth_pct_todo);
  });

  it('justo en el umbral: 8 periodos parea, 7 no', () => {
    const conN = (n: number) => correr([
      ...serie('x:01', 'mostrador', Y0, P1_9, 1_000_000),
      ...serie('x:01', 'mostrador', Y1, P1_9, 1_000_000),
      ...serie('x:02', 'mostrador', Y0, P1_9.slice(0, n), 1_000_000),
      ...serie('x:02', 'mostrador', Y1, P1_9, 1_000_000),
    ]).by_channel['mostrador'].cobertura;
    expect(conN(8)?.entidades_comparables).toBe(2);
    expect(conN(7)?.entidades_comparables).toBe(1);
  });

  it('un periodo en CERO no cuenta como cobertura: estar no es vender', () => {
    const cob = correr([
      ...serie('x:01', 'mostrador', Y0, P1_9, 1_000_000),
      ...serie('x:01', 'mostrador', Y1, P1_9, 1_000_000),
      // nueve periodos presentes en el año base, pero ocho de ellos en cero
      ...serie('x:02', 'mostrador', Y0, [1], 1_000_000),
      ...serie('x:02', 'mostrador', Y0, P1_9.slice(1), 0),
      ...serie('x:02', 'mostrador', Y1, P1_9, 1_000_000),
    ]).by_channel['mostrador'].cobertura;
    expect(cob?.entidades_comparables).toBe(1);
  });
});

describe('[PVI.12] el periodo abierto no es un periodo', () => {
  it('⛔ el abierto y los posteriores se excluyen — una fracción no se compara contra un entero', () => {
    const conAbierto = correr([
      ...ESCENARIO,
      // el periodo 10 del año reciente, enorme, no debe mover nada
      ...serie('mostrador:01', 'mostrador', Y1, [10, 11], 99_000_000),
    ]);
    expect(conAbierto.by_channel['mostrador'].growth_pct).toBe(0.1);
    expect(conAbierto.global.periodos_abiertos_excluidos).toBe(2);
  });

  /**
   * ⚠️ La primera versión de esta prueba estaba MAL y el motor tenía razón: le puse al periodo 10
   * datos sólo del año reciente, y así **nunca parea** —el pareo exige `a > 0 && b > 0` en el mismo
   * periodo—, así que quitarle el freno no cambiaba nada y la aserción fallaba.
   *
   * ⭐ O sea que hay **DOS protecciones independientes** y yo las había confundido en una: el pareo
   * por periodo cubre el periodo que no existe en el año base; el freno del `abierto` cubre el caso
   * de verdad peligroso — un periodo que SÍ tiene los dos años pero cuyo año reciente es una
   * **fracción transcurrida**. Eso es lo que se prueba acá, y es lo que dice el comentario del
   * motor: una fracción comparada contra un entero.
   */
  it('PRUEBA NEGATIVA: sin el freno, una fracción de periodo DILUYE el crecimiento', () => {
    const conFraccion: FilaReal[] = [
      ...ESCENARIO,
      // el periodo 10 existe en los DOS años, pero del reciente sólo transcurrió un décimo
      fila('mostrador:01', 'mostrador', Y0, 10, 1_000_000),
      fila('mostrador:01', 'mostrador', Y1, 10, 100_000),
    ];
    expect(correr(conFraccion).by_channel['mostrador'].growth_pct).toBe(0.1);                   // con freno
    expect(correr(conFraccion, { abierto: null }).by_channel['mostrador'].growth_pct).toBe(0);  // sin freno
  });
});

describe('[PVI.12] cuándo NO se puede medir, y qué se publica entonces', () => {
  it('con menos periodos apareados que el mínimo, el canal cae al global', () => {
    const r = correr([
      ...ESCENARIO,
      // un canal con sólo 3 periodos apareados: por debajo de MIN_PAIRED_PERIODS
      ...serie('ruta:01', 'ruta', Y0, [1, 2, 3], 100),
      ...serie('ruta:01', 'ruta', Y1, [1, 2, 3], 200),
    ], { canales: ['mostrador', 'preventa', 'ruta'] });
    expect(r.by_channel['ruta'].basis).toBe('global');
    expect(r.by_channel['ruta'].growth_pct).toBe(r.global.growth_pct);
  });

  it('sin NINGÚN canal medible, todo cae al respaldo declarado', () => {
    const r = correr([
      ...serie('x:01', 'mostrador', Y0, [1, 2], 100),
      ...serie('x:01', 'mostrador', Y1, [1, 2], 200),
    ]);
    expect(r.global.basis).toBe('default');
    expect(r.global.growth_pct).toBe(0.08);
    expect(r.by_channel['mostrador'].basis).toBe('default');
    expect(r.by_channel['mostrador'].years_used).toEqual([]);
  });

  it('⛔ [VSO.8] un canal del vocabulario SIN filas igual se declara — nunca se omite', () => {
    const r = correr(ESCENARIO, { canales: ['mostrador', 'preventa', 'mayoreo', 'contado_nf'] });
    expect(Object.keys(r.by_channel).sort()).toEqual(['contado_nf', 'mayoreo', 'mostrador', 'preventa']);
    expect(r.by_channel['mayoreo'].basis).toBe('global');
  });

  it('una base en CERO no produce un crecimiento infinito: se declara, no se publica', () => {
    const r = correr([
      ...serie('x:01', 'mostrador', Y0, P1_9, 0),
      ...serie('x:01', 'mostrador', Y1, P1_9, 1_000_000),
    ]);
    expect(r.global.basis).toBe('default');
    expect(Number.isFinite(r.by_channel['mostrador'].growth_pct)).toBe(true);
  });

  it('sin filas, no inventa: respaldo en todos los canales', () => {
    const r = correr([]);
    expect(r.global.basis).toBe('default');
    expect(r.by_channel['mostrador'].growth_pct).toBe(0.08);
    expect(r.by_channel['preventa'].growth_pct).toBe(0.08);
  });
});

describe('[PVI.12] el canal sano no se contagia del enfermo', () => {
  it('preventa mide 0 % y mostrador +10 %: el pareo es POR CANAL', () => {
    const r = correr(ESCENARIO);
    expect(r.by_channel['preventa'].growth_pct).toBe(0);
    expect(r.by_channel['preventa'].basis).toBe('yoy_paired');
    expect(r.by_channel['mostrador'].growth_pct).toBe(0.1);
  });

  it('el global mezcla los dos canales comparables, y lo dice', () => {
    const r = correr(ESCENARIO);
    // comparables: mostrador:01 (9M → 9.9M) + preventa:01 (4.5M → 4.5M) = 13.5M → 14.4M
    expect(r.global.basis).toBe('yoy_paired');
    expect(r.global.growth_pct).toBeCloseTo((14_400_000 - 13_500_000) / 13_500_000, 4);
    expect(r.global.cobertura.entidades_comparables).toBe(2);
    expect(r.global.cobertura.entidades_excluidas).toBe(1);
  });
});
