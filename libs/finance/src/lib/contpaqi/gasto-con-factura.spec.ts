import { asientoCuadra, AsientoRechazado } from './poliza-egreso';
import { armarGastoConFactura, type EntradaGasto, type FacturaGasto } from './gasto-con-factura';

/**
 * `[CP.8.87]` Candado del asiento de gasto con factura. El caso base es la póliza real que trajo el PM: Egreso 373 del
 * 21/sep/2026, un proveedor persona física, «PAGO MANT EQ DE REPARTO» — tres facturas del 23/ago.
 */
const fac = (p: Partial<FacturaGasto> = {}): FacturaGasto => ({ uuid: 'F-1', total: 3362, iva: 463.72, ieps: 0, retenido: 0, fecha: '2026-08-23', ...p });
const MANTENIMIENTO: EntradaGasto = {
  fecha: '2026-09-21', concepto: 'PAGO MANT EQ DE REPARTO', cuenta_banco: '1020210000', pagado: 10792, cuenta_gasto: '5200730000',
  facturas: [
    fac({ uuid: '33D35615', total: 3362, iva: 463.72 }),
    fac({ uuid: 'A29A6A8B', total: 4535, iva: 625.52 }),
    fac({ uuid: 'B3285E55', total: 2895, iva: 399.31 }),
  ],
};
const renglones = (a: { movimientos: { cuenta: string; abono: boolean; importe: number }[] }): string[] =>
  a.movimientos.map((m) => `${m.abono ? 'A' : 'C'} ${m.cuenta} ${m.importe.toFixed(2)}`);

describe('[CP.8.87] gasto con factura', () => {
  it('⭐ reproduce la póliza real del mantenimiento de reparto (Egreso 373, 21/sep/2026) renglón por renglón', () => {
    const a = armarGastoConFactura(MANTENIMIENTO);
    expect(renglones(a)).toEqual(['C 5200730000 9303.45', 'C 1060000000 1488.55', 'A 1020210000 10792.00']);
    expect(a.uuids).toEqual(['33D35615', 'A29A6A8B', 'B3285E55']);
    expect(asientoCuadra(a)).toBe(true);
    expect(a.total).toBe(10792);
  });

  it('el IEPS de la factura va a 1470100 y la base lo excluye', () => {
    const a = armarGastoConFactura({ ...MANTENIMIENTO, pagado: 1160, facturas: [fac({ total: 1160, iva: 100, ieps: 60 })] });
    expect(renglones(a)).toEqual(['C 5200730000 1000.00', 'C 1060000000 100.00', 'C 1470100000 60.00', 'A 1020210000 1160.00']);
  });

  it('centavos de diferencia van al redondeo y el asiento cuadra', () => {
    const a = armarGastoConFactura({ ...MANTENIMIENTO, pagado: 10791.94 });
    expect(renglones(a)).toContain('A 4200010000 0.06');
    expect(asientoCuadra(a)).toBe(true);
  });

  it('⛔ con retención NO se arma: esa póliza lleva renglones que el puente no emite', () => {
    expect(() => armarGastoConFactura({ ...MANTENIMIENTO, facturas: [fac({ retenido: 120 })], pagado: 3362 })).toThrow(AsientoRechazado);
    try { armarGastoConFactura({ ...MANTENIMIENTO, facturas: [fac({ retenido: 120 })], pagado: 3362 }); }
    catch (e) { expect((e as AsientoRechazado).motivo).toBe('retencion'); }
  });

  it('⛔ una cuenta que no es de gasto no se arma (cuadraría igual y no se vería hasta la balanza)', () => {
    for (const cuenta_gasto of ['2120000165', '1020210000', '52007300', '']) {
      expect(() => armarGastoConFactura({ ...MANTENIMIENTO, cuenta_gasto })).toThrow(/no es una cuenta de gasto/);
    }
  });

  it('⛔ si las facturas no dan lo pagado (≥ $1), no se arma: va a confirmar', () => {
    try { armarGastoConFactura({ ...MANTENIMIENTO, pagado: 11000 }); expect.unreachable(); }
    catch (e) { expect((e as AsientoRechazado).motivo).toBe('no_cuadra'); }
  });

  it('⛔ sin facturas no se arma', () => {
    expect(() => armarGastoConFactura({ ...MANTENIMIENTO, facturas: [] })).toThrow(/qué facturas/);
  });
});
