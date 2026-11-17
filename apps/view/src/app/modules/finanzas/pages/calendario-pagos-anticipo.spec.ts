import { avisoAnticipoDelPago } from './calendario-pagos-anticipo';

/** `[PGP.139]` El aviso de anticipo en la fila del pago. Vectores SINTÉTICOS. */
describe('[PGP.139] avisoAnticipoDelPago', () => {
  const f = (it: string, libre: number, yaTiene = false) => ({ it, libre, yaTiene });

  it('⭐ pago pendiente sin autorizar con anticipo libre: se ofrece aplicarlo a la primera factura que no lo trae', () => {
    expect(avisoAnticipoDelPago('pending', false, [f('A', 1227, true), f('B', 1227)])).toEqual({ it: 'B', libre: 1227, autorizado: false });
  });
  it('⛔ autorizado: se avisa, pero sin factura a la cual aplicarlo (está congelado)', () => {
    expect(avisoAnticipoDelPago('pending', true, [f('A', 8700)])).toEqual({ it: null, libre: 8700, autorizado: true });
  });
  it('⛔ un pago pagado o cancelado no avisa: ya no cambia lo que se transfiere', () => {
    expect(avisoAnticipoDelPago('executed', false, [f('A', 8700)])).toBeNull();
    expect(avisoAnticipoDelPago('cancelled', false, [f('A', 8700)])).toBeNull();
  });
  it('⛔ sin anticipo libre (o sólo centavos), o con todas las facturas ya aplicadas: no avisa', () => {
    expect(avisoAnticipoDelPago('pending', false, [f('A', 0)])).toBeNull();
    expect(avisoAnticipoDelPago('pending', false, [f('A', 0.004)])).toBeNull();
    expect(avisoAnticipoDelPago('pending', false, [f('A', 500, true)])).toBeNull();
    expect(avisoAnticipoDelPago('pending', false, [])).toBeNull();
  });
});
