import { armarRankings, LineaVenta, PromoBase, SucursalInfo, SIN_ZONA } from './mkt-venta.logic';

/**
 * `[MKT.30]`/`[MKT.31]` Los dos rankings. Cada caso tiene un resultado que se conoce de antemano.
 */
const SUC = new Map<string, SucursalInfo>([
  ['01', { nombre: 'Padre Hidalgo', zona: 'LA PIEDAD RD' }],
  ['02', { nombre: 'Abastos', zona: 'LA PIEDAD RD' }],
  ['06', { nombre: 'Canindo', zona: 'ZAMORA' }],
  ['04', { nombre: 'Yurécuaro', zona: null }],
]);
const PROMOS: PromoBase[] = [
  { promo_id: 'k-62253', code: '62253', nombre: '3 PROD LA ROSA', productos: ['R1', 'R2'] },
  { promo_id: 'k-09066', code: '09066', nombre: '3 LECHE SAN JUAN', productos: ['L1'] },
  { promo_id: 'k-00126', code: '00126', nombre: 'SIN PRODUCTO', productos: [] },
  // Comparte el producto R1 con La Rosa: un renglón que activa dos promos.
  { promo_id: 'k-77777', code: '77777', nombre: 'OTRA CON R1', productos: ['R1'] },
];
const L = (x: Partial<LineaVenta> & Pick<LineaVenta, 'ticket' | 'sku'>): LineaVenta => ({
  canal: 'mostrador', warehouse_code: '01', qty: 0, importe: 0, vendedor: null, ...x,
});

const base = (): LineaVenta[] => [
  // T1 (01, mostrador, asignado a la persona P1): 2 La Rosa con $100 de R1 y $50 de R2.
  L({ ticket: 'T1', sku: '62253', qty: 2, vendedor: 'P1' }),
  L({ ticket: 'T1', sku: 'R1', importe: 100, vendedor: 'P1' }),
  L({ ticket: 'T1', sku: 'R2', importe: 50, vendedor: 'P1' }),
  // T2 (01, mostrador, SIN asignar): 1 La Rosa y 1 «OTRA CON R1» sobre el mismo R1 de $40.
  L({ ticket: 'T2', sku: '62253', qty: 1 }),
  L({ ticket: 'T2', sku: '77777', qty: 1 }),
  L({ ticket: 'T2', sku: 'R1', importe: 40 }),
  // T3 (06, vecinal, ruta 1V001): 3 leches con $90 de leche, y 1 promo sin producto.
  L({ ticket: 'T3', canal: 'preventa', warehouse_code: '06', sku: '09066', qty: 3, vendedor: '06:1V001' }),
  L({ ticket: 'T3', canal: 'preventa', warehouse_code: '06', sku: 'L1', importe: 90, vendedor: '06:1V001' }),
  L({ ticket: 'T3', canal: 'preventa', warehouse_code: '06', sku: '00126', qty: 4, vendedor: '06:1V001' }),
  // T4 (04, sin zona, camioneta): 1 leche con $30.
  L({ ticket: 'T4', canal: 'ruta', warehouse_code: '04', sku: '09066', qty: 1, vendedor: 'ruta:21' }),
  L({ ticket: 'T4', canal: 'ruta', warehouse_code: '04', sku: 'L1', importe: 30, vendedor: 'ruta:21' }),
  // T5: R1 vendido SIN ninguna promoción en el ticket — no es dinero de ninguna promo.
  L({ ticket: 'T5', sku: 'R1', importe: 999 }),
];

const armar = (filtro = {}, lineas = base(), objetivos: Parameters<typeof armarRankings>[0]['objetivos'] = []) =>
  armarRankings({ lineas, promos: PROMOS, objetivos, sucursales: SUC, filtro });

describe('[MKT.30] ranking de promociones (toda la venta)', () => {
  it('ordena por paquetes y cuenta TODA la venta, asignada o no', () => {
    const r = armar();
    // Empate en paquetes: primero la de más dinero; la que no tiene dato va detrás.
    expect(r.promos.map((p) => [p.code, p.paquetes])).toEqual([['09066', 4], ['00126', 4], ['62253', 3], ['77777', 1]]);
    expect(r.totales.paquetes).toBe(12);
    expect(r.totales.promos).toBe(4);
  });

  it('[MKT.31] dinero = lo cobrado de SUS productos en SUS tickets; sin producto = null, nunca 0', () => {
    const r = armar();
    const de = (c: string) => r.promos.find((p) => p.code === c)!;
    expect(de('62253').dinero).toBe(190); // T1: 100 + 50 · T2: 40
    expect(de('77777').dinero).toBe(40);  // el mismo R1 de T2
    expect(de('09066').dinero).toBe(120); // 90 + 30
    expect(de('00126').dinero).toBeNull();
    expect(r.totales.promos_sin_dato).toBe(1);
  });

  it('[MKT.31] el total no cuenta dos veces un producto que activa dos promociones, ni el de un ticket sin promo', () => {
    const r = armar();
    // Sumando por promoción serían 190 + 40 + 120 = 350; el R1 de T2 ($40) va una vez y T5 ($999) no entra.
    expect(r.totales.dinero).toBe(310);
  });

  it('desglosa por canal y por sucursal con su zona; una sucursal sin zona dice «Sin zona»', () => {
    const leche = armar().promos.find((p) => p.code === '09066')!;
    expect(leche.por_canal).toEqual([{ canal: 'preventa', paquetes: 3, dinero: 90 }, { canal: 'ruta', paquetes: 1, dinero: 30 }]);
    expect(leche.por_sucursal.map((s) => [s.warehouse_code, s.zona, s.paquetes])).toEqual([['06', 'ZAMORA', 3], ['04', SIN_ZONA, 1]]);
  });

  it('filtra por canal, sucursal y zona (también «Sin zona»)', () => {
    expect(armar({ canal: 'mostrador' }).promos.map((p) => p.code)).toEqual(['62253', '77777']);
    expect(armar({ sucursal: '06' }).totales.paquetes).toBe(7);
    expect(armar({ zona: 'LA PIEDAD RD' }).totales.dinero).toBe(190);
    const sinZona = armar({ zona: SIN_ZONA });
    expect(sinZona.promos.map((p) => [p.code, p.paquetes])).toEqual([['09066', 1]]);
  });

  it('la sucursal que más vendió, con su zona', () => {
    expect(armar().sucursal_top).toEqual({ warehouse_code: '06', nombre: 'Canindo', zona: 'ZAMORA', paquetes: 7 });
    expect(armar({ canal: 'mayoreo' }).sucursal_top).toBeNull();
  });

  it('objetivo y avance: sólo los objetivos dentro del filtro', () => {
    const objetivos = [
      { promo_id: 'k-09066', canal: 'preventa' as const, warehouse_code: '06', objetivo: 6 },
      { promo_id: 'k-09066', canal: 'ruta' as const, warehouse_code: '04', objetivo: 2 },
    ];
    const todo = armar({}, base(), objetivos).promos.find((p) => p.code === '09066')!;
    expect(todo.objetivo).toBe(8);
    expect(todo.avance).toBe(0.5);
    const vecinal = armar({ canal: 'preventa' }, base(), objetivos).promos.find((p) => p.code === '09066')!;
    expect(vecinal.objetivo).toBe(6);
    expect(vecinal.por_sucursal[0].objetivo).toBe(6);
    expect(armar().promos.find((p) => p.code === '62253')!.objetivo).toBeNull();
  });
});

describe('[MKT.30] ranking de vendedores (sólo lo que se le cargó)', () => {
  it('un ticket de mostrador sin asignar no se le carga a nadie y se cuenta aparte', () => {
    const r = armar();
    expect(r.vendedores.map((v) => v.clave)).toEqual(['preventa|06|06:1V001', 'mostrador|01|P1', 'ruta|04|ruta:21']);
    expect(r.mostrador).toEqual({ tickets_con_promo: 2, tickets_asignados: 1 });
    // El vendedor suma menos que la promoción: T2 no es de nadie.
    expect(r.vendedores.find((v) => v.vendedor === 'P1')!.paquetes).toBe(2);
  });

  it('cada promoción del vendedor con precio (lo que pagó el cliente por paquete) y total', () => {
    const p1 = armar().vendedores.find((v) => v.vendedor === 'P1')!;
    expect(p1.promos).toEqual([{ code: '62253', nombre: '3 PROD LA ROSA', paquetes: 2, precio: 75, total: 150 }]);
    expect(p1.total).toBe(150);
    expect(p1.tickets).toBe(1);
  });

  it('una promoción sin producto: paquetes sí, precio y total no (y se cuenta)', () => {
    const v = armar().vendedores.find((x) => x.vendedor === '06:1V001')!;
    expect(v.paquetes).toBe(7);
    expect(v.promos.find((x) => x.code === '00126')).toEqual({ code: '00126', nombre: 'SIN PRODUCTO', paquetes: 4, precio: null, total: null });
    expect(v.total).toBe(90);
    expect(v.promos_sin_dato).toBe(1);
  });

  it('fuera de mostrador no hay conteo de asignación', () => {
    expect(armar({ canal: 'ruta' }).mostrador).toBeNull();
  });
});
