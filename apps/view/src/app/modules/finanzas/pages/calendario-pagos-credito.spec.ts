import { notaAplicable } from './calendario-pagos-credito';

/** `[PGP.141]` Notas de crédito aplicables por sucursal. Vectores SINTÉTICOS. */
describe('[PGP.141] notaAplicable', () => {
  const s = (sucursal: string, a_favor: number, con_deuda = true, clases = 'Devolución de compra') => ({ sucursal, clases, a_favor, docs: 1, con_deuda });

  it('⭐ crédito en la sucursal de la factura, con deuda ahí: aplicable, con sus clases en minúsculas', () => {
    expect(notaAplicable([s('00', 69052.5), s('06', 100)], '00')).toEqual({ a_favor: 69052.5, clases: 'devolución de compra' });
  });
  it('⛔ el crédito de OTRA sucursal no es aplicable a esta factura', () => {
    expect(notaAplicable([s('06', 5000)], '00')).toBeNull();
  });
  it('⛔ sin deuda en esa sucursal no hay contra qué aplicarlo', () => {
    expect(notaAplicable([s('00', 5000, false)], '00')).toBeNull();
  });
  it('⛔ centavos, lista vacía o sin sucursal: no avisa', () => {
    expect(notaAplicable([s('00', 0.004)], '00')).toBeNull();
    expect(notaAplicable([], '00')).toBeNull();
    expect(notaAplicable(undefined, '00')).toBeNull();
    expect(notaAplicable([s('00', 5000)], null)).toBeNull();
  });
});
