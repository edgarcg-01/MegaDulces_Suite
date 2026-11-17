import {
  columnaAbonoKdxg, columnaCargoKdxg, columnasKdc126, filasKdc126, movimientosDePoliza, movimientosKdc126, movimientosKdcn26,
  padresDelDepartamento, periodoKdcn26, tablaPolizaDelMes, type PolizaKepler,
} from './kepler-contable';

/**
 * La contabilidad interna de Kepler. Los números de columna salen de medir oficinas (`00`) en octubre y noviembre
 * de 2026: si alguien los mueve un mes, estas pruebas lo ven antes que la balanza de Kepler.
 */
describe('kepler-contable', () => {
  it('la tabla de pólizas es la del mes de la fecha', () => {
    expect(tablaPolizaDelMes('2026-11-09')).toBe('kdc22611');
    expect(tablaPolizaDelMes('2027-01-02')).toBe('kdc22701');
    expect(tablaPolizaDelMes('2026-13-01')).toBeNull();
    expect(tablaPolizaDelMes('09/11/2026')).toBeNull();
    expect(tablaPolizaDelMes('2026-11-09; DROP')).toBeNull();
  });

  it('⭐ kdc126: noviembre carga c37 y c61, abona c73 y c85 (medido al centavo en 102 y 201)', () => {
    expect(columnasKdc126(11)).toEqual({ cargo: ['c37', 'c61'], abono: ['c73', 'c85'] });
    expect(columnasKdc126(10)).toEqual({ cargo: ['c36', 'c60'], abono: ['c72', 'c84'] });
    expect(columnasKdc126(1)).toEqual({ cargo: ['c27', 'c51'], abono: ['c63', 'c75'] });
  });

  it('⭐ kdxg: el abono de noviembre va en c45 (CC016: $244,537.92, su único pago del mes)', () => {
    expect(columnaAbonoKdxg(11)).toBe('c45');
    expect(columnaAbonoKdxg(1)).toBe('c35');
    expect(columnaAbonoKdxg(12)).toBe('c46');
  });

  it('⛔ un mes fuera de 1..12 no produce un nombre de columna', () => {
    expect(() => columnasKdc126(0)).toThrow();
    expect(() => columnaAbonoKdxg(13)).toThrow();
    expect(() => columnaAbonoKdxg(1.5)).toThrow();
  });

  it('suma los renglones por cuenta y naturaleza, a centavos', () => {
    expect(movimientosDePoliza({ tipo: 'E', fecha: '2026-11-09', renglones: [
      { c3: '201', c4: 'C', c5: 0.1 }, { c3: '201', c4: 'C', c5: 0.2 }, { c3: ' 102 ', c4: 'A', c5: 0.3 },
    ] })).toEqual([{ cuenta: '102', cargo: 0, abono: 0.3 }, { cuenta: '201', cargo: 0.3, abono: 0 }]);
  });

  // ── [PGP.123] El gasto: cargos de kdxg, el mayor de kdc126 y el ejercido por centro de costo (kdcn26) ───────────
  // Validado con la sombra (anexo G §13): con TODAS las pólizas de oct y nov, kdcn26 2,824 de 2,824 y 1,718 de 1,718
  // celdas, y kdc126 (cuenta y mayor) 552 de 552 y 437 de 437 filas, iguales a las de Kepler.

  it('⭐ kdxg: el cargo (el gasto) de noviembre va en c57; enero c47, diciembre c58', () => {
    expect(columnaCargoKdxg(11)).toBe('c57');
    expect(columnaCargoKdxg(1)).toBe('c47');
    expect(columnaCargoKdxg(12)).toBe('c58');
    expect(() => columnaCargoKdxg(0)).toThrow();
  });

  it('⭐ kdc126: la subcuenta suma también a su mayor (el primer segmento); una cuenta sin guion, sólo a sí misma', () => {
    expect(filasKdc126('611-003')).toEqual(['611-003', '611']);
    expect(filasKdc126(' 122-001 ')).toEqual(['122-001', '122']);
    expect(filasKdc126('201')).toEqual(['201']);
    expect(filasKdc126('')).toEqual([]);
    const p: PolizaKepler = { tipo: 'D', fecha: '2026-11-13', renglones: [
      { c3: '201', c4: 'A', c5: 116 }, { c3: '122-001', c4: 'C', c5: 16 }, { c3: '611-003', c4: 'C', c5: 60 }, { c3: '611-012', c4: 'C', c5: 40 },
    ] };
    expect(movimientosKdc126(p)).toEqual([
      { cuenta: '122', cargo: 16, abono: 0 }, { cuenta: '122-001', cargo: 16, abono: 0 }, { cuenta: '201', cargo: 0, abono: 116 },
      { cuenta: '611', cargo: 100, abono: 0 }, { cuenta: '611-003', cargo: 60, abono: 0 }, { cuenta: '611-012', cargo: 40, abono: 0 },
    ]);
  });

  it('kdcn26: el periodo es AAMM de la fecha', () => {
    expect(periodoKdcn26('2026-11-13')).toBe('2611');
    expect(periodoKdcn26('2027-01-02')).toBe('2701');
    expect(periodoKdcn26('13/11/2026')).toBeNull();
  });

  it('⭐ kdcn26: sólo acumulan los departamentos padre que existen en kdc3 (194 de 194 sí; 0 de 3,238 no)', () => {
    const kdc3 = new Set(['1-02', '1-02-32-00', '9']);
    expect(padresDelDepartamento('1-02-32-00', kdc3)).toEqual(['1-02']);
    expect(padresDelDepartamento('1-02-32', kdc3)).toEqual(['1-02']);
    expect(padresDelDepartamento('1-05-01-00', kdc3)).toEqual([]);
    expect(padresDelDepartamento('', kdc3)).toEqual([]);
  });

  it('⭐ kdcn26: cada renglón va a (concepto; depto, padres y *; proyecto y *), con cargo − abono', () => {
    const kdc3 = new Set(['1-02']);
    const p: PolizaKepler = { tipo: 'D', fecha: '2026-11-13', renglones: [
      { c3: '201', c4: 'A', c5: 116, c13: '', c20: '', c21: '' },
      { c3: '122-001', c4: 'C', c5: 16, c13: '', c20: '', c21: '' },
      { c3: '611-003', c4: 'C', c5: 100, c13: '1-02-32-00', c20: '199', c21: '2-15-26-02' },
    ] };
    const m = movimientosKdcn26(p, kdc3);
    const celda = (c: string, d: string, pr: string) => m.find((x) => x.concepto === c && x.departamento === d && x.proyecto === pr)?.importe;
    // El gasto: (2 + 1 padre) × 2 = 6 celdas de +100.
    for (const d of ['1-02-32-00', '1-02', '*']) for (const pr of ['2-15-26-02', '*']) expect(celda('199', d, pr)).toBe(100);
    // Sin segmentos (el abono y el IVA, juntos): 4 celdas de −116 + 16 = −100 (medido en 00, 05 y 07: las 4 iguales).
    for (const d of ['', '*']) for (const pr of ['', '*']) expect(celda('', d, pr)).toBe(-100);
    expect(m).toHaveLength(10);
    expect(new Set(m.map((x) => x.periodo))).toEqual(new Set(['2611']));
  });

  it('⛔ kdcn26: un padre que NO está en kdc3 no acumula (si se cuela, el ejercido de Kepler crece de más)', () => {
    const p: PolizaKepler = { tipo: 'D', fecha: '2026-11-13', renglones: [{ c3: '611-003', c4: 'C', c5: 50, c13: '1-05-01-00', c20: '199', c21: 'P1' }] };
    expect(movimientosKdcn26(p, new Set()).map((x) => x.departamento)).toEqual(['*', '*', '1-05-01-00', '1-05-01-00']);
  });
});
