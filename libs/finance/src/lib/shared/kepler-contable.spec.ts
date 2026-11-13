import { columnaAbonoKdxg, columnasKdc126, movimientosDePoliza, tablaPolizaDelMes } from './kepler-contable';

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
});
