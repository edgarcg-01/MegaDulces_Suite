import { llavesDeSucursal, MapaDeSucursal, sucursalDelCatalogo } from './sucursal';

// Conceptos con la forma de los estados de cuenta reales; terminales, tarjetas y afiliaciones inventadas.
const tpv = (terminal: string) => ({ amount_in: 100, concepto: `VENTAS DEBITO/${terminal} TERMINALES PUNTO DE VENTA` });
const gas = (tarjeta: string, lugar = 'GASOLINERA') => ({ amount_in: 0, concepto: `Compra - Disposicion por POS por (200.00) mxn en ${lugar} | Tarjeta ${tarjeta} | Recibo # 1` });

describe('[CB.61] sucursal sin el libro', () => {
  it('saca la llave del texto del banco: terminal, tarjeta, afiliación y, si no hay otra, el concepto', () => {
    expect(llavesDeSucursal(tpv('100000001'))[0]).toEqual(['terminal', '100000001']);
    expect(llavesDeSucursal(gas('1111222233334444'))[0]).toEqual(['tarjeta', '1111222233334444']);
    expect(llavesDeSucursal({ amount_in: 0, concepto: 'RENTA TERMINAL PUNTO DE VENTA', referencia: 'AFIL.-007000001' })[0]).toEqual(['afiliacion', '007000001']);
    expect(llavesDeSucursal({ amount_in: 0, concepto: 'IVA TASA DE DESC DEBITO/100000001 TERMINALES' })[0]).toEqual(['terminal', '100000001']);
    expect(llavesDeSucursal({ amount_in: 5, concepto: 'DULCERIA LOS ALTOS 0012C' })).toEqual([['concepto', 'D|DULCERIA LOS ALTOS #C']]);
  });

  it('[negativa] en una compra con tarjeta el lugar NO es llave: la caseta se carga a quien trae la tarjeta', () => {
    expect(llavesDeSucursal(gas('1111222233334444', 'PZA COBRO')).map((k) => k[0])).toEqual(['tarjeta']);
  });

  it('aprende la sucursal de una llave y la deduce después', () => {
    const m = new MapaDeSucursal();
    m.aprender(tpv('100000001'), '40');
    expect(m.deducir(tpv('100000001'))).toBeNull(); // [negativa] vista una sola vez todavía no basta
    m.aprender(tpv('100000001'), '40');
    expect(m.deducir(tpv('100000001'))).toEqual({ sucursal: '40', por: 'terminal' });
    expect(m.deducir(tpv('100000002'))?.por).not.toBe('terminal'); // otra terminal no la hereda por terminal
  });

  it('[negativa] una llave que tuvo dos sucursales no da ninguna: no se adivina', () => {
    const m = new MapaDeSucursal();
    m.aprender(gas('1111222233334444'), '50');
    m.aprender(gas('1111222233334444'), '50');
    m.aprender(gas('1111222233334444'), '54');
    expect(m.deducir(gas('1111222233334444'))).toBeNull();
  });

  it('[CB.60b] al usar el banco se guardan SÓLO las llaves que ya se creen (puras y vistas 2+ veces)', () => {
    const m = new MapaDeSucursal();
    m.aprender(tpv('100000001'), '40'); m.aprender(tpv('100000001'), '40'); // pura, 2 veces → se guarda
    m.aprender(tpv('100000002'), '42');                                    // pura, 1 vez → no
    m.aprender(gas('1111222233334444'), '50'); m.aprender(gas('1111222233334444'), '54'); // impura → no
    const puras = m.llavesPuras().filter((k) => k.tipo !== 'concepto');
    expect(puras).toEqual([{ tipo: 'terminal', valor: '100000001', sucursal: '40', veces: 2 }]);
  });

  it('[CB.60b] sin libro, la sucursal sale del catálogo confirmado; una llave que no está no da ninguna', () => {
    const catalogo = new Map([['terminal|100000001', '40']]);
    expect(sucursalDelCatalogo(tpv('100000001'), catalogo)).toEqual({ sucursal: '40', por: 'terminal' });
    expect(sucursalDelCatalogo(tpv('100000099'), catalogo)).toBeNull();
  });
});
