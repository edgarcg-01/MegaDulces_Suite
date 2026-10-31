import { asientoCuadra, AsientoRechazado } from './poliza-egreso';
import { armarComisionesDelMes, type EntradaComisiones } from './comisiones';

/**
 * `[CP.8.91]` Candado del armador de comisiones. Puro. El caso base es la forma medida en sus 117 pólizas de ene–sep:
 * un cargo agregado a la cuenta de gasto, uno agregado al IVA, y un abono por cada movimiento de banco.
 */
const BANCO = '1020020000';
const GASTO = '5200650000';
const base: EntradaComisiones = {
  mes: '2026-09', cuenta_banco: BANCO, alias: 'BBVA 0001', cuenta_gasto: GASTO,
  comisiones: [
    { id: 'b', fecha: '2026-09-15', importe: 5, iva: 0.8 },
    { id: 'a', fecha: '2026-09-02', importe: 12.5, iva: 2 },
    { id: 'c', fecha: '2026-09-15', importe: 30, iva: null },
  ],
};
const renglones = (a: { movimientos: { cuenta: string; abono: boolean; importe: number }[] }): string[] =>
  a.movimientos.map((m) => `${m.abono ? 'A' : 'C'} ${m.cuenta} ${m.importe.toFixed(2)}`);

describe('[CP.8.91] comisiones bancarias por banco y mes', () => {
  it('⭐ control: cargos agregados (gasto e IVA) y un abono por movimiento, en orden de fecha, a fin de mes', () => {
    const a = armarComisionesDelMes(base);
    expect(renglones(a)).toEqual([
      'C 5200650000 47.50', 'C 1060000000 2.80',
      'A 1020020000 12.50', 'A 1020020000 2.00', 'A 1020020000 5.00', 'A 1020020000 0.80', 'A 1020020000 30.00',
    ]);
    expect(a.tipo_poliza).toBe(2);
    expect(a.fecha).toBe('2026-09-30');
    expect(a.concepto).toBe('PAGO COMISIONES BBVA 0001');
    expect(a.total).toBe(50.3);
    expect(asientoCuadra(a)).toBe(true);
  });

  it('sin IVA en todo el mes no lleva renglón de IVA', () => {
    const a = armarComisionesDelMes({ ...base, comisiones: [{ id: 'x', fecha: '2026-09-01', importe: 10, iva: null }] });
    expect(renglones(a)).toEqual(['C 5200650000 10.00', 'A 1020020000 10.00']);
  });

  it('el orden no depende de cómo llegan', () => {
    const a = armarComisionesDelMes(base);
    const b = armarComisionesDelMes({ ...base, comisiones: [...base.comisiones].reverse() });
    expect(renglones(b)).toEqual(renglones(a));
  });

  it('sin alias, el título lleva la cuenta del banco', () => {
    expect(armarComisionesDelMes({ ...base, alias: null }).concepto).toBe(`PAGO COMISIONES ${BANCO}`);
  });

  it('⛔ una cuenta que no es de gasto no se arma', () => {
    for (const cuenta_gasto of ['2120000165', '1060000000', '52006500', '']) {
      expect(() => armarComisionesDelMes({ ...base, cuenta_gasto })).toThrow(AsientoRechazado);
    }
  });

  it('⛔ sin comisiones no hay póliza, y un importe no positivo tampoco se arma', () => {
    try { armarComisionesDelMes({ ...base, comisiones: [] }); expect.unreachable(); } catch (e) { expect((e as AsientoRechazado).motivo).toBe('sin_comisiones'); }
    try { armarComisionesDelMes({ ...base, comisiones: [{ id: 'z', fecha: '2026-09-01', importe: 0, iva: null }] }); expect.unreachable(); }
    catch (e) { expect((e as AsientoRechazado).motivo).toBe('importe_invalido'); }
  });

  it('el IVA suelto del banco (sin su comisión en Bancos) entra al IVA y lleva su propio abono, en orden de fecha', () => {
    const a = armarComisionesDelMes({ ...base, comisiones: [base.comisiones[1]], ivas_sueltos: [{ id: 's1', fecha: '2026-09-20', importe: 1.6 }] });
    expect(renglones(a)).toEqual(['C 5200650000 12.50', 'C 1060000000 3.60', 'A 1020020000 12.50', 'A 1020020000 2.00', 'A 1020020000 1.60']);
    expect(asientoCuadra(a)).toBe(true);
  });

  it('⛔ un IVA suelto no positivo no se arma, y sin comisiones el IVA suelto solo no hace póliza', () => {
    expect(() => armarComisionesDelMes({ ...base, ivas_sueltos: [{ id: 's', fecha: '2026-09-01', importe: 0 }] })).toThrow(AsientoRechazado);
    expect(() => armarComisionesDelMes({ ...base, comisiones: [], ivas_sueltos: [{ id: 's', fecha: '2026-09-01', importe: 1 }] })).toThrow(/no tiene comisiones/);
  });

  it('los centavos se suman en enteros: tres comisiones de 0.10 dan 0.30 exacto', () => {
    const a = armarComisionesDelMes({ ...base, comisiones: [1, 2, 3].map((i) => ({ id: `p${i}`, fecha: '2026-09-01', importe: 0.1, iva: null })) });
    expect(a.movimientos[0].importe).toBe(0.3);
    expect(asientoCuadra(a)).toBe(true);
  });
});
