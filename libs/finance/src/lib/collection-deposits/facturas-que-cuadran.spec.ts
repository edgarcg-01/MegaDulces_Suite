import { FACTURAS_SI_NO_CUADRA, elegirFacturasQueCuadran, type FacturaQueCuadra } from './customer-deposits.service';

/**
 * `[CC.31]` Qué factura proponerle a quien va a capturar el cobro en Kepler. Cada guarda con su **prueba negativa**
 * (regla 12). El caso de arriba es el real del 2026-11-26: un depósito de $15,539.63 que paga, al centavo, una
 * factura de ese mismo importe.
 *
 * ⛔ Lo que estas pruebas defienden: que la Suite **no afirme más de lo que sabe**. Proponer por cercanía, o sumar
 * dos facturas que casualmente dan el importe, es el cruce por importe sin control negativo.
 */
const f = (folio: string, saldo: number, importe = saldo): FacturaQueCuadra => ({
  doc_code: 'UD0801', folio, importe, saldo, fecha: '2026-11-18', vencimiento: '2026-11-17',
});

describe('[CC.31] elegirFacturasQueCuadran', () => {
  it('el caso real: una factura por el importe exacto → «exacta»', () => {
    const r = elegirFacturasQueCuadran(15539.63, [f('0000433', 6979.95), f('0001446', 15539.63), f('0001543', 11468.06)]);
    expect(r.modo).toBe('exacta');
    expect(r.facturas.map((x) => x.folio)).toEqual(['0001446']);
    expect(r.monto).toBe(15539.63);
  });

  it('dos que cuadran → «una_de_varias»: las ofrece, NO elige por la persona', () => {
    const r = elegirFacturasQueCuadran(500, [f('A', 500), f('B', 500), f('C', 900)]);
    expect(r.modo).toBe('una_de_varias');
    expect(r.facturas.map((x) => x.folio)).toEqual(['A', 'B']);
  });

  it('⛔ ninguna cuadra sola → «parcial», y NO propone la suma de dos que den el importe', () => {
    // 300 + 200 = 500, y aun así no se propone esa combinación: que sumen lo mismo no prueba nada.
    const r = elegirFacturasQueCuadran(500, [f('A', 300), f('B', 200), f('C', 50)]);
    expect(r.modo).toBe('parcial');
    expect(r.facturas.map((x) => x.folio)).toEqual(['A', 'B', 'C']);
  });

  it('⛔ el centavo manda: $500.01 NO cuadra con una de $500', () => {
    expect(elegirFacturasQueCuadran(500.01, [f('A', 500)]).modo).toBe('parcial');
    expect(elegirFacturasQueCuadran(500, [f('A', 500)]).modo).toBe('exacta');          // el control
  });

  it('medio centavo de redondeo sí cuadra (los importes vienen de dos lados)', () => {
    expect(elegirFacturasQueCuadran(500.004, [f('A', 500)]).modo).toBe('exacta');
    expect(elegirFacturasQueCuadran(500.02, [f('A', 500)]).modo).toBe('parcial');      // el control
  });

  it('sin facturas vivas, o con un importe que no es un número, no inventa nada', () => {
    expect(elegirFacturasQueCuadran(500, [])).toEqual({ modo: 'parcial', monto: 500, facturas: [] });
    expect(elegirFacturasQueCuadran(Number.NaN, [f('A', 500)]).facturas).toEqual([]);
    expect(elegirFacturasQueCuadran(0, [f('A', 500)]).facturas).toEqual([]);
    expect(elegirFacturasQueCuadran(-5, [f('A', 500)]).facturas).toEqual([]);
  });

  it('cuando ninguna cuadra, ofrece las más viejas y se topa', () => {
    const muchas = Array.from({ length: 10 }, (_, i) => f(`F${i}`, 100 + i));
    const r = elegirFacturasQueCuadran(99999, muchas);
    expect(r.modo).toBe('parcial');
    expect(r.facturas).toHaveLength(FACTURAS_SI_NO_CUADRA);
    expect(r.facturas[0].folio).toBe('F0');        // el orden que trae la consulta es por fecha
  });

  it('una factura con saldo no numérico se ignora, no truena', () => {
    const rota = { ...f('X', 0), saldo: Number.NaN } as FacturaQueCuadra;
    const r = elegirFacturasQueCuadran(500, [rota, f('A', 500)]);
    expect(r.modo).toBe('exacta');
    expect(r.facturas.map((x) => x.folio)).toEqual(['A']);
  });
});
