import { cuadreTurno, pideRetiro, CUADRE_UMBRAL } from './cash-cut-identity';

/**
 * SM.35 — La identidad del cuadre de caja, con los numeros REALES de prod.
 *
 * Los fixtures no son inventados: son los turnos que la pantalla publicaba mal
 * (medidos el 2026-09-15 contra `postgres_platform` de Railway). Cada bloque
 * trae, ademas del resultado correcto, la PRUEBA NEGATIVA: que la formula vieja
 * —`esperado - cajon`, sin restar los retiros— da el numero equivocado. Sin eso
 * la prueba solo confirma que la funcion hace lo que hace.
 */

/** La formula que estaba en `list()` y `porCajera()`. Existe para romperla. */
const formulaVieja = (esperado: number, cajon: number) =>
  Math.round((esperado - cajon) * 100) / 100;

describe('cuadreTurno — el retiro no es un faltante', () => {
  // 14/09 suc03 caja1 folio 272, cajera 40MJCC. La fila que abrio la
  // investigacion: la pantalla decia "+$41,949.70 FALTAN".
  const t1409 = {
    efectivo_esperado: 57833.7,
    efectivo_contado: 57833.7,   // c25 — igual al esperado, el patron no-ciego
    efectivo_diff: 0,            // c35 — Kepler lo dio por cuadrado
    arqueo_billetes: 15884,
    arqueo_monedas: 0,
    efectivo_retirado: 41950,
  };

  it('el turno CUADRA cuando se cuentan los retiros (−$0.30, no +$41,949.70)', () => {
    const c = cuadreTurno(t1409, { cajonContado: 15884, retirosContados: 8250 });
    expect(c.diff_real).toBe(-0.3);
    expect(c.contado_total).toBe(57834);
    expect(c.retiros_contados).toBe(8250);
    // Lo que salio y no contamos se declara APARTE, no se mezcla con el faltante.
    expect(c.retiros_sin_verificar).toBe(33700);
    expect(c.medible).toBe(true);
    expect(Math.abs(c.diff_real as number)).toBeLessThan(CUADRE_UMBRAL);
  });

  it('PRUEBA NEGATIVA: la formula vieja acusa $41,949.70 de faltante inventado', () => {
    const malo = formulaVieja(57833.7, 15884);
    expect(malo).toBe(41949.7);
    // Y es exactamente del tamano del retiro: el bug era contar la sangria dos veces.
    const c = cuadreTurno(t1409, { cajonContado: 15884, retirosContados: 8250 });
    expect(Math.round((malo - (c.diff_real as number)) * 100) / 100).toBe(41950);
    expect(malo).not.toBe(c.diff_real);
  });

  it('11/09 suc03 caja2 cuadra al centavo (+$0.01)', () => {
    const c = cuadreTurno(
      { efectivo_esperado: 48303.51, efectivo_contado: 48303.51, efectivo_diff: 0,
        arqueo_billetes: 4503.5, arqueo_monedas: 0, efectivo_retirado: 43800 },
      { cajonContado: 4503.5, retirosContados: 15800 });
    expect(c.diff_real).toBe(0.01);
    expect(formulaVieja(48303.51, 4503.5)).toBe(43800.01);  // lo que decia la pantalla
  });

  it('12/09 suc03 caja1 cuadra (+$9.77) donde la pantalla decia +$68,009.77', () => {
    const c = cuadreTurno(
      { efectivo_esperado: 74196.77, efectivo_contado: 74196.77, efectivo_diff: 0,
        arqueo_billetes: 6187, arqueo_monedas: 0, efectivo_retirado: 68000 },
      { cajonContado: 6187, retirosContados: 15000 });
    expect(c.diff_real).toBe(9.77);
    expect(formulaVieja(74196.77, 6187)).toBe(68009.77);
  });
});

describe('cuadreTurno — la diferencia que sale del propio Kepler', () => {
  /**
   * `diff_kepler` = c15 - (c43+c44+c48). Existe para TODOS los cortes, sin que
   * nadie arquee. Verificado: donde nuestro conteo coincidio con el cajon
   * declarado por Kepler, los dos caminos dan el MISMO numero al centavo.
   */
  const casos: Array<[string, any, number]> = [
    ['14/09 suc03 c1', { efectivo_esperado: 57833.7, arqueo_billetes: 15884, arqueo_monedas: 0, efectivo_retirado: 41950 }, -0.3],
    ['12/09 suc03 c1', { efectivo_esperado: 74196.77, arqueo_billetes: 6187, arqueo_monedas: 0, efectivo_retirado: 68000 }, 9.77],
    ['11/09 suc03 c2', { efectivo_esperado: 48303.51, arqueo_billetes: 4503.5, arqueo_monedas: 0, efectivo_retirado: 43800 }, 0.01],
    ['09/09 suc03 c3', { efectivo_esperado: 25704.52, arqueo_billetes: 10635, arqueo_monedas: 0, efectivo_retirado: 15000 }, 69.52],
    ['09/09 suc03 c1', { efectivo_esperado: 55607.33, arqueo_billetes: 15253.5, arqueo_monedas: 0, efectivo_retirado: 39400 }, 953.83],
  ];

  it.each(casos)('%s: diff_kepler sin necesidad de arqueo', (_n, cut, esperado) => {
    expect(cuadreTurno(cut).diff_kepler).toBe(esperado);
  });

  it('los dos caminos coinciden cuando contamos el MISMO cajon', () => {
    // 09/09 suc03 c1: nuestro conteo fue identico al declarado por Kepler.
    const cut = { efectivo_esperado: 55607.33, efectivo_contado: 55607.33, efectivo_diff: 0,
      arqueo_billetes: 15253.5, arqueo_monedas: 0, efectivo_retirado: 39400 };
    const c = cuadreTurno(cut, { cajonContado: 15253.5, retirosContados: 0 });
    expect(c.diff_real).toBe(953.83);
    expect(c.diff_kepler).toBe(953.83);
    expect(c.diff_real).toBe(c.diff_kepler);
  });

  it('destapa el enmascaramiento: Kepler dice cuadrado y su desglose lo niega', () => {
    // Mismo turno: c35 = 0 (cuadrado) contra $953.83 que implica el desglose.
    const c = cuadreTurno({ efectivo_esperado: 55607.33, efectivo_contado: 55607.33,
      efectivo_diff: 0, arqueo_billetes: 15253.5, arqueo_monedas: 0, efectivo_retirado: 39400 });
    expect(c.diff_publicado).toBe(0);
    expect(c.kepler_enmascaro).toBe(true);
  });

  it('un corte realmente cuadrado NO se marca como enmascarado', () => {
    // Prueba negativa del detector: sin esto, "todo enmascara" pasaria por exito.
    const c = cuadreTurno({ efectivo_esperado: 10000, efectivo_contado: 10000,
      efectivo_diff: 0, arqueo_billetes: 4000, arqueo_monedas: 0, efectivo_retirado: 6000 });
    expect(c.diff_kepler).toBe(0);
    expect(c.kepler_enmascaro).toBe(false);
  });
});

describe('cuadreTurno — lo que no se puede medir se declara', () => {
  it('esperado en 0 NO es "cuadro": es sin_esperado, y diff queda null', () => {
    const c = cuadreTurno({ efectivo_esperado: 0, efectivo_contado: 0, efectivo_diff: 0,
      arqueo_billetes: 0, arqueo_monedas: 0, efectivo_retirado: 0 }, { cajonContado: 12500 });
    expect(c.diff_real).toBeNull();
    expect(c.diff).toBeNull();
    expect(c.medible).toBe(false);
    expect(c.motivo).toBe('sin_esperado');
    // Lo importante: NO devuelve 0, que se leeria como turno sano.
    expect(c.diff_real).not.toBe(0);
  });

  it('sin desglose de Kepler y sin conteo nuestro: sin_desglose', () => {
    const c = cuadreTurno({ efectivo_esperado: 30000, efectivo_contado: 30000,
      efectivo_diff: 0, arqueo_billetes: null, arqueo_monedas: null, efectivo_retirado: 0 });
    expect(c.cajon_kepler).toBeNull();
    expect(c.diff).toBeNull();
    expect(c.motivo).toBe('sin_desglose');
    expect(c.kepler_enmascaro).toBe(false);   // no se acusa sin evidencia
  });

  it('con desglose pero sin conteo nuestro, diff_real es null y diff_kepler no', () => {
    const c = cuadreTurno({ efectivo_esperado: 25704.52, efectivo_contado: 25704.52,
      efectivo_diff: 0, arqueo_billetes: 10635, arqueo_monedas: 0, efectivo_retirado: 15000 });
    expect(c.diff_real).toBeNull();
    expect(c.diff_kepler).toBe(69.52);
    expect(c.diff).toBe(69.52);
    expect(c.medible).toBe(true);
  });

  it('la cobertura dice que porcion del efectivo paso por manos que contaron', () => {
    const c = cuadreTurno(
      { efectivo_esperado: 57833.7, arqueo_billetes: 15884, arqueo_monedas: 0, efectivo_retirado: 41950 },
      { cajonContado: 15884, retirosContados: 8250 });
    // (15884 + 8250) / 57833.7 = 0.42 — el resto es palabra de Kepler.
    expect(c.cobertura).toBeCloseTo(0.42, 2);
  });
});

describe('pideRetiro — el umbral es c46, y esta medido', () => {
  it('dispara al alcanzar el limite de ESA caja', () => {
    expect(pideRetiro(11307.74, 10000)).toBe(true);   // suc04 caja3, caso real de hoy
    expect(pideRetiro(10000, 10000)).toBe(true);      // el borde cuenta
  });

  it('NO dispara por debajo del limite', () => {
    expect(pideRetiro(12664.78, 15000)).toBe(false);  // suc03 caja1, mismo momento
    expect(pideRetiro(3161.03, 15000)).toBe(false);   // suc06 caja2 tras retirar $84,500
  });

  it('el limite NO es 15000 para todos: usa el de la caja', () => {
    // suc01 caja4 corre en $70,000 y suc04 caja2 en $8,000.
    expect(pideRetiro(14603.57, 70000)).toBe(false);
    expect(pideRetiro(9000, 8000)).toBe(true);
  });

  it('sin limite configurado no se inventa uno', () => {
    expect(pideRetiro(50000, 0)).toBe(false);
    expect(pideRetiro(50000, null)).toBe(false);
    expect(pideRetiro(null, 15000)).toBe(false);
  });
});
