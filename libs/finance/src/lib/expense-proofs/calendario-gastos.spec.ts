import { mesDe, mesValido, rangoDelMes, totalDelMes } from './calendario-gastos';

/**
 * `[GX.27]` El rango de un mes decide **qué gasto entra en qué mes**. Si el límite se corre un
 * día, el total de un mes se come el último día del otro — y nadie lo nota hasta que dos
 * cifras que deberían cuadrar no cuadran.
 */

describe('[GX.27] qué mes se está mirando', () => {
  it('acepta un mes ISO', () => {
    expect(mesValido('2026-09')).toBe('2026-09');
    expect(mesValido('2026-09-26')).toBe('2026-09');
  });

  /** ⛔ Un parámetro roto NO cae al mes actual: si cayera, se vería igual que un mes sin gasto. */
  it('lo ilegible devuelve null, no «este mes»', () => {
    for (const v of ['', 'septiembre', '09-2026', '2026/09', null, undefined, {}]) {
      expect(mesValido(v)).toBeNull();
    }
  });

  it('un mes que no existe se rechaza', () => {
    expect(mesValido('2026-00')).toBeNull();
    expect(mesValido('2026-13')).toBeNull();
    expect(mesValido('1899-05')).toBeNull();
  });

  it('el mes de un día sale del día', () => {
    expect(mesDe('2026-09-26')).toBe('2026-09');
    expect(mesDe('2026-01-01')).toBe('2026-01');
    expect(mesDe('no es fecha')).toBeNull();
  });
});

describe('[GX.27] el rango del mes', () => {
  /**
   * ⭐ El límite superior es el **día 1 del siguiente**, medio abierto. Calcular «el último
   * día del mes» a mano es de donde salen los febreros rotos y los gastos del 31 perdidos.
   */
  it('va del 1 al 1 del mes siguiente', () => {
    expect(rangoDelMes('2026-09')).toEqual({ desde: '2026-09-01', hasta: '2026-10-01' });
  });

  it('cruza el año sin romperse', () => {
    expect(rangoDelMes('2026-12')).toEqual({ desde: '2026-12-01', hasta: '2027-01-01' });
  });

  /** Febrero no necesita saber cuántos días tiene: el rango lo resuelve solo. */
  it('febrero, bisiesto o no, se resuelve igual', () => {
    expect(rangoDelMes('2026-02')).toEqual({ desde: '2026-02-01', hasta: '2026-03-01' });
    expect(rangoDelMes('2028-02')).toEqual({ desde: '2028-02-01', hasta: '2028-03-01' });
  });

  it('los meses de un dígito van con cero', () => {
    expect(rangoDelMes('2026-01')).toEqual({ desde: '2026-01-01', hasta: '2026-02-01' });
    expect(rangoDelMes('2026-11')).toEqual({ desde: '2026-11-01', hasta: '2026-12-01' });
  });

  /** Ningún día queda afuera ni entra dos veces: el `hasta` de un mes es el `desde` del otro. */
  it('meses consecutivos se tocan sin hueco ni traslape', () => {
    for (let m = 1; m <= 11; m++) {
      const mes = `2026-${String(m).padStart(2, '0')}`;
      const sig = `2026-${String(m + 1).padStart(2, '0')}`;
      expect(rangoDelMes(mes).hasta).toBe(rangoDelMes(sig).desde);
    }
  });
});

describe('[GX.27] el total del mes', () => {
  it('un mes sin movimiento da ceros, no revienta', () => {
    expect(totalDelMes([])).toEqual({ n: 0, monto: 0 });
  });

  /** ⭐ El encabezado tiene que ser la suma exacta de las celdas: es lo primero que se verifica. */
  it('suma los días al centavo', () => {
    const r = totalDelMes([
      { dia: '2026-09-01', n: 2, monto: 33.33 },
      { dia: '2026-09-02', n: 1, monto: 33.33 },
      { dia: '2026-09-30', n: 3, monto: 33.34 },
    ]);
    expect(r).toEqual({ n: 6, monto: 100 });
  });

  it('un día con basura cuenta como cero, no rompe el total', () => {
    const r = totalDelMes([
      { dia: '2026-09-01', n: 1, monto: 10 },
      { dia: '2026-09-02', n: Number.NaN, monto: Number.NaN },
    ]);
    expect(r).toEqual({ n: 1, monto: 10 });
  });
});
