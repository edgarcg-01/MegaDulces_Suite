import { mesDe, semanasDelMes, sumarMeses, type CeldaCalendario } from './calendario-mes.util';

/**
 * `[GX.27]` La rejilla del mes. Un calendario que corre un día, o que pierde el 31, es un
 * error que se ve tarde y se cree temprano: nadie recuenta un calendario a mano.
 */

const plano = (mes: string, dias = [] as { dia: string; n: number; monto: number }[], hoy = '') =>
  semanasDelMes(mes, dias, hoy).flat();

describe('[GX.27] la rejilla del mes', () => {
  it('cada semana tiene siete casilleros', () => {
    for (const mes of ['2026-01', '2026-02', '2026-09', '2028-02', '2026-08']) {
      for (const semana of semanasDelMes(mes)) expect(semana).toHaveLength(7);
    }
  });

  /**
   * ⭐ La columna tiene que corresponder al día de la semana que rotula. Se arranca en
   * domingo (`DIAS_SEMANA` = D L M M J V S), así que la primera celda SIEMPRE es domingo.
   */
  it('siempre arranca en domingo', () => {
    for (const mes of ['2026-01', '2026-02', '2026-09', '2027-11']) {
      const primera = semanasDelMes(mes)[0][0];
      expect(new Date(`${primera.dia}T00:00:00Z`).getUTCDay()).toBe(0);
    }
  });

  /** ⛔ Ni un día del mes puede faltar: el 31 perdido es el clásico. */
  it('están TODOS los días del mes, una sola vez', () => {
    const casos: [string, number][] = [
      ['2026-01', 31], ['2026-02', 28], ['2028-02', 29], ['2026-04', 30], ['2026-09', 30], ['2026-12', 31],
    ];
    for (const [mes, cuantos] of casos) {
      const delMes = plano(mes).filter((c) => c.delMes);
      expect(delMes).toHaveLength(cuantos);
      expect(delMes[0].numero).toBe(1);
      expect(delMes[cuantos - 1].numero).toBe(cuantos);
      expect(new Set(delMes.map((c) => c.dia)).size).toBe(cuantos);
    }
  });

  /**
   * ⚠️ `new Date('2026-09-01')` es medianoche UTC: en México cae el 31 de agosto 18:00. Si la
   * rejilla se armara así, el mes entero saldría corrido un día.
   */
  it('el día 1 es el día 1, no el último del mes anterior', () => {
    const primero = plano('2026-09').find((c) => c.delMes);
    expect(primero?.dia).toBe('2026-09-01');
    expect(primero?.numero).toBe(1);
  });

  it('el relleno de los extremos queda marcado como ajeno', () => {
    // Septiembre 2026 arranca en martes → 2 celdas de agosto adelante.
    const celdas = plano('2026-09');
    expect(celdas[0].delMes).toBe(false);
    expect(celdas[0].dia).toBe('2026-08-30');
    expect(celdas.filter((c) => !c.delMes).every((c) => c.n === 0)).toBe(true);
  });

  it('un mes que arranca en domingo no lleva relleno adelante', () => {
    // Febrero 2026 arranca en domingo.
    const celdas = plano('2026-02');
    expect(celdas[0].dia).toBe('2026-02-01');
    expect(celdas[0].delMes).toBe(true);
  });

  it('un mes ilegible devuelve una rejilla vacía, no una inventada', () => {
    for (const v of ['', '2026', '2026-13', '2026-00', 'septiembre']) {
      expect(semanasDelMes(v)).toEqual([]);
    }
  });
});

describe('[GX.27] lo que cada día muestra', () => {
  const DIAS = [
    { dia: '2026-09-01', n: 3, monto: 1500.5 },
    { dia: '2026-09-26', n: 19, monto: 85161.65 },
  ];

  it('pega el conteo y el monto en su día', () => {
    const celdas = plano('2026-09', DIAS);
    const uno = celdas.find((c) => c.dia === '2026-09-01');
    const veintiseis = celdas.find((c) => c.dia === '2026-09-26');
    expect(uno).toMatchObject({ n: 3, monto: 1500.5, delMes: true });
    expect(veintiseis).toMatchObject({ n: 19, monto: 85161.65 });
  });

  /** El servidor sólo manda los días CON movimiento; la rejilla completa el resto en cero. */
  it('los días sin gasto quedan en cero, no en blanco', () => {
    const celdas = plano('2026-09', DIAS);
    const dos = celdas.find((c) => c.dia === '2026-09-02');
    expect(dos).toMatchObject({ n: 0, monto: 0, delMes: true });
  });

  /** ⭐ La suma de las celdas del mes tiene que ser el total que dice el encabezado. */
  it('la suma de las celdas es el total del mes, al centavo', () => {
    const celdas = plano('2026-09', DIAS).filter((c: CeldaCalendario) => c.delMes);
    expect(celdas.reduce((a, c) => a + c.n, 0)).toBe(22);
    expect(Math.round(celdas.reduce((a, c) => a + c.monto, 0) * 100) / 100).toBe(86662.15);
  });

  it('marca hoy, y sólo hoy', () => {
    const celdas = plano('2026-09', DIAS, '2026-09-26');
    expect(celdas.filter((c) => c.esHoy).map((c) => c.dia)).toEqual(['2026-09-26']);
  });

  it('sin hoy, ninguna celda se marca', () => {
    expect(plano('2026-09', DIAS).some((c) => c.esHoy)).toBe(false);
  });

  /** Un día del mes vecino que sí tuvo gasto NO suma acá: pertenece al otro mes. */
  it('el gasto de un día ajeno no se cuela en el relleno', () => {
    const celdas = plano('2026-09', [{ dia: '2026-08-30', n: 5, monto: 999 }]);
    const relleno = celdas.find((c) => c.dia === '2026-08-30');
    expect(relleno?.delMes).toBe(false);
    // Se PINTA el dato (el día existe), pero el total del mes sólo suma `delMes`.
    expect(celdas.filter((c) => c.delMes).reduce((a, c) => a + c.n, 0)).toBe(0);
  });
});

describe('[GX.27] moverse de mes', () => {
  it('avanza y retrocede', () => {
    expect(sumarMeses('2026-09', 1)).toBe('2026-10');
    expect(sumarMeses('2026-09', -1)).toBe('2026-08');
  });

  it('cruza el año en los dos sentidos', () => {
    expect(sumarMeses('2026-12', 1)).toBe('2027-01');
    expect(sumarMeses('2026-01', -1)).toBe('2025-12');
    expect(sumarMeses('2026-06', -12)).toBe('2025-06');
  });

  it('un mes ilegible se devuelve tal cual, no se inventa uno', () => {
    expect(sumarMeses('nada', 1)).toBe('nada');
  });

  it('el mes de un día sale del día', () => {
    expect(mesDe('2026-09-26')).toBe('2026-09');
    expect(mesDe('no es fecha')).toBe('');
  });
});
