import { agruparPorProveedor, LineaCompra, repartoProducto } from './pedido-requisicion-global';

const L = (o: Partial<LineaCompra>): LineaCompra => ({
  supplierId: 'S1', supplierName: 'BOLSAS DE LOS ALTOS', productId: 'P1', sku: '17083', nombre: 'ALTOS CAM CHICA',
  uxc: 20, unidad: 'kg', branchCode: '01', branchName: 'Padre Hidalgo', entregaCode: '01', entregaName: 'Padre Hidalgo',
  cajas: 1, valor: 100, ...o,
});

describe('[RA-PRO.54] agruparPorProveedor — una hoja por proveedor', () => {
  it('separa proveedores y los ordena por importe', () => {
    const h = agruparPorProveedor([
      L({ supplierId: 'S1', supplierName: 'A', valor: 100 }),
      L({ supplierId: 'S2', supplierName: 'B', productId: 'P2', valor: 900 }),
    ]);
    expect(h.map((x) => x.supplierName)).toEqual(['B', 'A']);
  });

  it('un punto consolidado suma lo de todas las sucursales que bajan de él', () => {
    const [h] = agruparPorProveedor([
      L({ branchCode: '01', entregaCode: '00', entregaName: 'CEDIS', cajas: 148, valor: 148 * 862 }),
      L({ branchCode: '03', branchName: '8ESQ', entregaCode: '00', entregaName: 'CEDIS', cajas: 25, valor: 25 * 862 }),
    ]);
    expect(h.puntos).toEqual([{ code: '00', name: 'CEDIS', consolidado: true, cajas: 173, valor: 173 * 862 }]);
    expect(h.nTraspasos).toBe(2);
    expect(h.productos[0].porPunto).toEqual({ '00': 173 });
  });

  it('pedido partido: un punto por cada lugar de entrega, consolidados primero', () => {
    const [h] = agruparPorProveedor([
      L({ branchCode: '05', entregaCode: '05', entregaName: 'Zamora', cajas: 50, valor: 5000 }),
      L({ branchCode: '01', entregaCode: '00', entregaName: 'CEDIS', cajas: 10, valor: 1000 }),
    ]);
    expect(h.puntos.map((p) => [p.code, p.consolidado])).toEqual([['00', true], ['05', false]]);
    expect(h.productos[0].porPunto).toEqual({ '05': 50, '00': 10 });
    expect(h.productos[0].cajas).toBe(60);
  });

  it('la repartición pone al CEDIS que "se queda" primero y no repite destinos', () => {
    const [h] = agruparPorProveedor([
      L({ branchCode: '07', branchName: 'Madero', entregaCode: '08', entregaName: 'Abastos', cajas: 9 }),
      L({ branchCode: '08', branchName: 'Abastos', entregaCode: '08', entregaName: 'Abastos', cajas: 5 }),
      L({ productId: 'P2', sku: '99001', branchCode: '07', branchName: 'Madero', entregaCode: '08', entregaName: 'Abastos', cajas: 2 }),
    ]);
    expect(h.repartos).toHaveLength(1);
    expect(h.repartos[0].destinos.map((d) => d.code)).toEqual(['08', '07']);
    expect(h.repartos[0].filas.map((f) => [f.sku, f.porDestino])).toEqual([
      ['17083', { '07': 9, '08': 5 }],
      ['99001', { '07': 2 }],
    ]);
  });

  it('una entrega directa no genera repartición ni traspasos', () => {
    const [h] = agruparPorProveedor([L({ cajas: 3 })]);
    expect(h.repartos).toEqual([]);
    expect(h.nTraspasos).toBe(0);
    expect(h.puntos[0].consolidado).toBe(false);
  });

  it('ignora renglones en cero o inválidos', () => {
    expect(agruparPorProveedor([L({ cajas: 0 }), L({ cajas: NaN }), L({ cajas: -2 })])).toEqual([]);
  });

  it('la repartición de un proveedor no mezcla renglones de otro que entrega en el mismo CEDIS', () => {
    const h = agruparPorProveedor([
      L({ supplierId: 'S1', supplierName: 'A', branchCode: '01', entregaCode: '00', entregaName: 'CEDIS', cajas: 4, valor: 400 }),
      L({ supplierId: 'S2', supplierName: 'B', productId: 'P9', branchCode: '03', entregaCode: '00', entregaName: 'CEDIS', cajas: 7, valor: 700 }),
    ]);
    const a = h.find((x) => x.supplierName === 'A');
    expect(a?.repartos[0].destinos.map((d) => d.code)).toEqual(['01']);
  });
});

describe('[RA-PRO.53] repartoProducto — la repartición del PDF por producto', () => {
  const R = (branchCode: string, entregaCode: string | null, cajas: number) => ({ branchCode, entregaCode, cajas });

  it('todo consolidado en 00: un bloque con todas las sucursales, sin bloque directo', () => {
    const g = repartoProducto([R('01', '00', 148), R('03', '00', 25)]);
    expect(g).toHaveLength(1);
    expect(g[0].receptor).toBe('00');
    expect(g[0].cajas).toBe(173);
    expect(g[0].filas.map((f) => [f.item.branchCode, f.seQueda])).toEqual([['01', false], ['03', false]]);
  });

  it('el CEDIS que también pide para sí "se queda" y va primero', () => {
    const g = repartoProducto([R('05', '06', 14), R('06', null, 18)]);
    expect(g).toHaveLength(1);
    expect(g[0].receptor).toBe('06');
    expect(g[0].filas.map((f) => [f.item.branchCode, f.seQueda])).toEqual([['06', true], ['05', false]]);
    expect(g[0].cajas).toBe(32);
  });

  it('pedido partido: bloques de CEDIS por cajas y al final el directo', () => {
    const g = repartoProducto([R('08', null, 0.25), R('06', '06', 5), R('01', '00', 74), R('05', '06', 14)]);
    expect(g.map((x) => [x.receptor, x.cajas])).toEqual([['00', 74], ['06', 19], [null, 0.25]]);   // 06 = 5 se queda + 14 baja
    // 06 consolidado en sí mismo cuenta como directo… pero 06 es receptor (le baja 05), así que "se queda".
    expect(g[1].filas.map((f) => [f.item.branchCode, f.seQueda])).toEqual([['06', true], ['05', false]]);
  });

  it('todo directo: un solo bloque sin receptor', () => {
    const g = repartoProducto([R('01', null, 3), R('02', '02', 4)]);
    expect(g).toEqual([{ receptor: null, cajas: 7, filas: [
      { item: R('01', null, 3), seQueda: false }, { item: R('02', '02', 4), seQueda: false }] }]);
  });

  it('ignora renglones en cero o inválidos', () => {
    expect(repartoProducto([R('01', '00', 0), R('02', null, NaN)])).toEqual([]);
  });
});
