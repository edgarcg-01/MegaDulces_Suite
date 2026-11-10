import { candadosDelDia } from './comisiones-kepler.query';

/**
 * `[CB.62]` Los tres candados contra duplicados, con los casos que los motivaron (medidos en prod el 2026-11-10).
 * Lo que importa son los negativos: cada uno es una forma de escribir en Kepler un gasto que Finanzas ya capturó.
 */
const com = (o: { kepler_pago?: string | null; kepler_gasto?: string | null } = {}) => ({ tipo: 'comision' as const, kepler_pago: null, kepler_gasto: null, ...o });
const iva = (o: { kepler_pago?: string | null } = {}) => ({ tipo: 'iva' as const, kepler_pago: null, kepler_gasto: null, ...o });

describe('[CB.62] candadosDelDia', () => {
  it('un día sin nada de Finanzas pasa (null): se puede armar', () => {
    expect(candadosDelDia([com(), iva()], [])).toBeNull();
  });

  it('⛔ 1 · todos sus pagos ya capturados → ya_en_kepler', () => {
    expect(candadosDelDia([com({ kepler_pago: '0000232' }), iva({ kepler_pago: '0000233' })], [])?.estado).toBe('ya_en_kepler');
  });

  it('⛔ 2 · parte de los pagos capturados → parcial', () => {
    const r = candadosDelDia([com({ kepler_pago: '0000232' }), iva()], []);
    expect(r?.estado).toBe('parcial');
    expect(r?.motivos.join(' ')).toMatch(/1 de 2 pagos capturados/);
  });

  it('⛔ 2 · el gasto 0000321 de Morelia Abastos ya capturado SIN ningún pago → parcial, no se duplica', () => {
    const r = candadosDelDia([com({ kepler_gasto: 'gasto 0000321' }), iva(), com({ kepler_gasto: 'gasto 0000321' }), iva()], []);
    expect(r?.estado).toBe('parcial');
    expect(r?.motivos.join(' ')).toMatch(/2 de 2 comisiones .*gasto 0000321.*ningún pago capturado/);
  });

  it('⛔ 3 · Yurécuaro 4-nov: Finanzas tiene un gasto de ese día con otros importes → parcial', () => {
    const r = candadosDelDia([com(), iva()], ['gasto 0000084 ($17.32)']);
    expect(r?.estado).toBe('parcial');
    expect(r?.motivos[0]).toMatch(/gasto 0000084.*otros importes/);
  });

  it('un día sin cargos no se da por capturado (no es «todos sus pagos»)', () => {
    expect(candadosDelDia([], [])).toBeNull();
  });
});
