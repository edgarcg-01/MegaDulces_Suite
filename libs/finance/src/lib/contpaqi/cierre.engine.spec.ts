import { describe, it, expect } from 'vitest';
import type { KpiUmbral } from '@megadulces/contracts';
import {
  armarCierre, familiasSinUmbral, normalizarUmbrales, mesDe, mesMenos,
  MOTIVO_EN_CURSO, PREFIJO_KPI, type FilaCierreCruda,
} from './cierre.engine';

/**
 * `[CPA.0]` Candado de la REGLA del semáforo de cierre. Puro: sin base, sin Nest, sin jsdom.
 *
 * Lo que prueba no es "¿corre?" sino las cuatro formas en que este semáforo puede **mentir sin
 * dejar de verse plausible**:
 *
 *  1. ⛔ que un mes sin umbral salga **verde** (el `cfg ? classify : 'ok'` de la Fase VP);
 *  2. ⛔ que el **mes en curso** salga rojo y el tablero grite todos los días 1;
 *  3. ⛔ que los umbrales lleguen de Postgres como **texto** y la comparación se vuelva
 *     lexicográfica — un semáforo que compara cadenas no falla: miente;
 *  4. ⛔ que un mes con una familia en rojo salga **verde por mayoría**.
 *
 * Los números de los casos son los REALES de prod (medidos el 2026-10-10), no inventados.
 */

const UMBRAL_COMPRAS: KpiUmbral = {
  kpi_key: PREFIJO_KPI + 'compras',
  position_code: null,
  period: 'mes',
  target: 0.5,
  warn_at: 0.2,
  escalate_at: 0.1,
  direction: 'higher_is_better',
  escalate_to: 'jefe_finanzas',
  source: 'banda medida abr-ago 2026',
  manual_lock: true,
  auto_tuned_at: null,
};

const fila = (over: Partial<FilaCierreCruda> = {}): FilaCierreCruda => ({
  anio_mes: '2026-09',
  familia: 'compras',
  etiqueta: 'Compras del mes',
  senal_cuentas: 'abonos 2120*',
  senal: '0',
  senal_renglones: '0',
  provisional: null,
  testigo: '45141396',
  testigo_fuente: 'fiscal.cfdis recibidas',
  cobertura_base: 'testigo',
  mediana_6m: null,
  cobertura: '0.0000',
  periodo_estado: 'cerrado',
  ...over,
});

describe('[CPA.0] el hecho que funda la fase', () => {
  it('septiembre-2026 compras: cobertura 0 contra un testigo real → bad, y escala', () => {
    const [mes] = armarCierre([fila()], [UMBRAL_COMPRAS]);
    expect(mes.familias[0].estado).toBe('bad');
    expect(mes.familias[0].escala_a).toBe('jefe_finanzas');
    expect(mes.estado).toBe('bad');
  });

  it('julio y agosto, con la cobertura real medida, salen verdes (el control: no todo es rojo)', () => {
    const jul = armarCierre([fila({ anio_mes: '2026-07', cobertura: '0.6729', senal: '33804766', senal_renglones: '279' })], [UMBRAL_COMPRAS]);
    const ago = armarCierre([fila({ anio_mes: '2026-08', cobertura: '0.7038', senal: '40929080', senal_renglones: '293' })], [UMBRAL_COMPRAS]);
    expect(jul[0].familias[0].estado).toBe('ok');
    expect(ago[0].familias[0].estado).toBe('ok');
  });

  it('⛔ NEGATIVA — "$0" y "ni un renglón" son cosas distintas y las dos viajan', () => {
    const [mes] = armarCierre([fila({ senal: '0', senal_renglones: '0' })], [UMBRAL_COMPRAS]);
    expect(mes.familias[0].senal).toBe(0);
    expect(mes.familias[0].senal_renglones).toBe(0);
    // Un mes puede tener renglones y sumar cero (reclasificaciones que se cancelan): no es lo mismo.
    const [otro] = armarCierre([fila({ senal: '0', senal_renglones: '12' })], [UMBRAL_COMPRAS]);
    expect(otro.familias[0].senal_renglones).toBe(12);
  });
});

describe('[CPA.0] ⛔ sin umbral NO es verde', () => {
  it('sin ninguna regla registrada, una cobertura perfecta sale sin_meta — no ok', () => {
    const [mes] = armarCierre([fila({ cobertura: '0.95' })], []);
    expect(mes.familias[0].estado).toBe('sin_meta');
    expect(mes.familias[0].umbral).toBeNull();
    expect(mes.estado).toBe('sin_meta');
  });

  it('…y la cobertura declarada nombra a la familia que quedó sin umbral', () => {
    expect(familiasSinUmbral([fila(), fila({ familia: 'ventas' })], [UMBRAL_COMPRAS]))
      .toEqual(['ventas']);
  });

  it('⛔ NEGATIVA — sin cifra NO es lo mismo que mal: cobertura null → sin_medir, no bad', () => {
    const [mes] = armarCierre([fila({ cobertura: null })], [UMBRAL_COMPRAS]);
    expect(mes.familias[0].estado).toBe('sin_medir');
  });
});

describe('[CPA.0] ⛔ el mes en curso no se juzga', () => {
  it('con cobertura 0 —porque el mes apenas empezó— sale sin_medir con motivo, NO bad', () => {
    const [mes] = armarCierre(
      [fila({ anio_mes: '2026-10', cobertura: '0.0000', periodo_estado: 'en_curso' })],
      [UMBRAL_COMPRAS],
    );
    expect(mes.familias[0].estado).toBe('sin_medir');
    expect(mes.familias[0].motivo).toBe(MOTIVO_EN_CURSO);
    expect(mes.familias[0].escala_a).toBeNull();
  });

  it('⛔ NEGATIVA — el MISMO número en un mes CERRADO sí es bad: la diferencia es el periodo', () => {
    const [cerrado] = armarCierre(
      [fila({ anio_mes: '2026-09', cobertura: '0.0000', periodo_estado: 'cerrado' })],
      [UMBRAL_COMPRAS],
    );
    expect(cerrado.familias[0].estado).toBe('bad');
  });
});

describe('[CPA.0] los números llegan como TEXTO desde Postgres', () => {
  const crudo = [{
    kpi_key: PREFIJO_KPI + 'compras', position_code: null, period: 'mes',
    target: '0.5000', warn_at: '0.2000', escalate_at: '0.1000',
    direction: 'higher_is_better', escalate_to: 'jefe_finanzas',
    source: 'medido', manual_lock: true, auto_tuned_at: null,
  }];

  it('normalizarUmbrales los vuelve números', () => {
    const [u] = normalizarUmbrales(crudo);
    expect(u.target).toBe(0.5);
    expect(typeof u.target).toBe('number');
  });

  it('con ellos normalizados, 0.9045 alcanza la meta 0.5 → ok', () => {
    const [mes] = armarCierre([fila({ cobertura: '0.9045' })], normalizarUmbrales(crudo));
    expect(mes.familias[0].estado).toBe('ok');
  });

  /*
   * ⚠️ CORRECCIÓN de una afirmación que escribí mal y el propio candado desmintió.
   *
   * Yo había puesto acá *"sin normalizar, la comparación es lexicográfica y miente"*. **Es falso
   * en este camino**: JavaScript COACCIONA el string a número cuando el otro lado ES número, y
   * `clasificarKpi` siempre recibe un `valor` numérico porque el engine lo convierte. Así que un
   * umbral en texto NO tuerce el veredicto.
   *
   * La comparación sólo se vuelve lexicográfica si **los DOS lados son texto**. O sea: lo que de
   * verdad protege es que el engine numere la COBERTURA, no que los umbrales vengan limpios.
   * Estas dos pruebas fijan eso, que es lo cierto.
   */
  it('⭐ lo que salva el veredicto es que el engine numere la COBERTURA, no el umbral', () => {
    const sucio = crudo as unknown as KpiUmbral[];
    const [mes] = armarCierre([fila({ cobertura: '0.08' })], sucio);
    // 0.08 está por DEBAJO de escalate_at (0.1): el veredicto correcto es `bad`, y lo es.
    expect(mes.familias[0].estado).toBe('bad');
  });

  it('⛔ NEGATIVA — el caso que SÍ se voltearía si los dos lados fueran texto: 10.5 contra 9', () => {
    // `'10.5' >= '9'` es FALSE por orden lexicográfico ('1' < '9'), y 10.5 >= 9 es TRUE.
    expect('10.5' >= '9').toBe(false);
    const u9: KpiUmbral[] = [{ ...UMBRAL_COMPRAS, target: 9, warn_at: 5, escalate_at: 1 }];
    // Cobertura > 1 es real en la base `historia` (gastos de sep-2026 dio 1.3868).
    const [mes] = armarCierre([fila({ cobertura: '10.5' })], u9);
    expect(mes.familias[0].estado).toBe('ok');
  });

  it('⚠️ el umbral PUBLICADO sale tal como vino: por eso normalizar corre en el servicio', () => {
    const sucio = crudo as unknown as KpiUmbral[];
    const [mes] = armarCierre([fila()], sucio);
    expect(typeof mes.familias[0].umbral?.target).toBe('string');
    const [limpio] = armarCierre([fila()], normalizarUmbrales(crudo));
    expect(typeof limpio.familias[0].umbral?.target).toBe('number');
  });
});

describe('[CPA.0] el mes toma el PEOR de sus familias', () => {
  const reglas = ['compras', 'ventas', 'bancos'].map((f) => ({ ...UMBRAL_COMPRAS, kpi_key: PREFIJO_KPI + f }));

  it('⛔ NEGATIVA — dos familias verdes NO tapan a una roja', () => {
    const [mes] = armarCierre([
      fila({ familia: 'ventas', cobertura: '0.9045' }),
      fila({ familia: 'bancos', cobertura: '0.9285' }),
      fila({ familia: 'compras', cobertura: '0.0000' }),
    ], reglas);
    expect(mes.estado).toBe('bad');
    expect(mes.conteo).toMatchObject({ ok: 2, bad: 1 });
  });

  it('con todas verdes, el mes es verde', () => {
    const [mes] = armarCierre([
      fila({ familia: 'ventas', cobertura: '0.9045' }),
      fila({ familia: 'bancos', cobertura: '0.9285' }),
    ], reglas);
    expect(mes.estado).toBe('ok');
  });

  it('una familia sin umbral degrada el mes a sin_meta aunque las otras estén bien', () => {
    const [mes] = armarCierre([
      fila({ familia: 'ventas', cobertura: '0.9045' }),
      fila({ familia: 'nomina', cobertura: '1.0639' }),
    ], reglas);
    expect(mes.familias.find((f) => f.familia === 'nomina')?.estado).toBe('sin_meta');
    expect(mes.estado).toBe('sin_meta');
  });

  it('agrupa por mes sin reordenar: el ORDER BY de la consulta es la única opinión', () => {
    const meses = armarCierre([
      fila({ anio_mes: '2026-09' }),
      fila({ anio_mes: '2026-08', cobertura: '0.7038' }),
      fila({ anio_mes: '2026-09', familia: 'ventas', cobertura: '0.9045' }),
    ], reglas);
    expect(meses.map((m) => m.anio_mes)).toEqual(['2026-09', '2026-08']);
    expect(meses[0].familias).toHaveLength(2);
  });
});

describe('[CPA.0] la ventana de meses', () => {
  it('mesDe usa hora local, no UTC', () => {
    expect(mesDe(new Date(2026, 9, 10))).toBe('2026-10');
  });

  it('mesMenos cruza el año hacia atrás', () => {
    expect(mesMenos('2026-10', 12)).toBe('2025-10');
    expect(mesMenos('2026-01', 1)).toBe('2025-12');
    expect(mesMenos('2026-03', 6)).toBe('2025-09');
  });

  it('⛔ NEGATIVA — el día 31 no se "cae" al mes siguiente como haría restarle meses a un Date', () => {
    // new Date(2026,2,31) menos un mes da 3 de marzo con aritmética de Date. Acá no hay días.
    expect(mesMenos('2026-03', 1)).toBe('2026-02');
  });
});
