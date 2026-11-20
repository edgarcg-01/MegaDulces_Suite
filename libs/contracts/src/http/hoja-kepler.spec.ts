import { esSoloHojaKepler, paqueteSoloHojaKepler } from './hoja-kepler';

describe('[RE.82] la hoja de Kepler sola no es evidencia', () => {
  it('una hoja que sólo trae la Aplica Orden Entrada es la hoja de Kepler', () => {
    expect(esSoloHojaKepler(['aplica_orden_entrada'])).toBe(true);
  });

  it('con papel del proveedor al lado ya no lo es (factura, remisión, nota de venta, vale, otro)', () => {
    for (const otro of ['factura', 'remision', 'ticket', 'vale', 'otro']) {
      expect(esSoloHojaKepler(['aplica_orden_entrada', otro])).toBe(false);
    }
  });

  it('sin lectura no se afirma nada', () => {
    expect(esSoloHojaKepler([])).toBe(false);
    expect(esSoloHojaKepler(null)).toBe(false);
    expect(esSoloHojaKepler([null, undefined])).toBe(false);
  });

  it('el paquete frena sólo si TODAS sus hojas son la de Kepler', () => {
    expect(paqueteSoloHojaKepler([['aplica_orden_entrada']])).toBe(true);
    expect(paqueteSoloHojaKepler([['aplica_orden_entrada'], ['aplica_orden_entrada']])).toBe(true);
    // la factura en otra hoja del paquete
    expect(paqueteSoloHojaKepler([['aplica_orden_entrada'], ['factura']])).toBe(false);
    // una hoja que no se pudo leer puede ser la factura: no se frena
    expect(paqueteSoloHojaKepler([['aplica_orden_entrada'], null])).toBe(false);
    expect(paqueteSoloHojaKepler([])).toBe(false);
  });
});
