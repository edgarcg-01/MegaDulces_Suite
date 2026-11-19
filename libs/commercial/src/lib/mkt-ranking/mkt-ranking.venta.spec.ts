import { MktRankingService } from './mkt-ranking.service';
import type { ProductosDePromo } from './mkt-ranking.logic';

/**
 * `[MKT.30]`/`[MKT.31]` `venta()`: de las filas de la base a los dos rankings. La base se simula y
 * cada consulta se reconoce por lo que lee. Lo que se prueba aquí es la TRADUCCIÓN (llave del ticket,
 * vendedora que asignó la cajera, camionetas, nombre del vendedor, zona); las reglas de suma están
 * en `mkt-venta.logic.spec.ts`.
 */
type Fila = Record<string, unknown>;
interface Fake {
  keplerLineas: Fila[];
  camionetasLineas?: Fila[];
  asignadas?: Fila[];
  asignacionRutas?: Fila[];
  /** Renglón de `mkt_ranking_promos` (ya tiene objetivos) y sus objetivos fijados. */
  registradas?: Fila[];
  fijos?: Fila[];
  barrasTruena?: boolean;
}

const SEMANA_PROMO = [
  { canal: 'mostrador', sku: '62253', warehouse_code: '01', primera: new Date('2026-11-10T00:00:00Z') },
  { canal: 'preventa', sku: '62253', warehouse_code: '01', primera: new Date('2026-11-10T00:00:00Z') },
];

function fakeTrx(f: Fake) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const raw = (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/trade\.zones/.test(sql)) {
      return Promise.resolve({ rows: [
        { code: '01', name: 'Padre Hidalgo', zona: 'LA PIEDAD RD' },
        { code: '04', name: 'Yurécuaro', zona: null },
      ] });
    }
    if (/product_barcodes/.test(sql)) return f.barrasTruena ? Promise.reject(new Error('sin permiso')) : Promise.resolve({ rows: [{ sku: 'R1', codigos: ['7501000000017'] }] });
    if (/daily_assignments/.test(sql)) return Promise.resolve({ rows: f.asignacionRutas ?? [] });
    if (/commission_route_config/.test(sql)) return Promise.resolve({ rows: [] });
    if (/WITH tk AS MATERIALIZED/.test(sql) && /v_route_sales_lines/.test(sql)) return Promise.resolve({ rows: f.camionetasLineas ?? [] });
    if (/WITH tk AS MATERIALIZED/.test(sql) && /v_kepler_sales_lines/.test(sql)) return Promise.resolve({ rows: f.keplerLineas });
    if (/v_route_sales_lines/.test(sql) && /min\(sl\.business_date\)/.test(sql)) {
      return Promise.resolve({ rows: (f.camionetasLineas ?? []).length
        ? [{ canal: 'ruta', sku: '62253', warehouse_code: '04', primera: new Date('2026-11-10T00:00:00Z'), en_ventana: true }] : [] });
    }
    if (/FROM catalog\.products/.test(sql) && /GROUP BY 1/.test(sql)) return Promise.resolve({ rows: [{ code: '62253', nombre: '3 PROD LA ROSA = GRATIS 1' }] });
    if (/v_kepler_sales_lines/.test(sql) && /min\(business_date\)/.test(sql)) {
      const canales = params[params.length - 1] as string[];
      return Promise.resolve({ rows: SEMANA_PROMO.filter((r) => canales.includes(r.canal)) });
    }
    return Promise.resolve({ rows: [] });
  };
  const builder = (tabla: string) => {
    const filas = tabla === 'commercial.mkt_promo_ticket_sellers' ? (f.asignadas ?? [])
      : tabla === 'commercial.mkt_ranking_promos as p' ? (f.registradas ?? [])
        : tabla === 'commercial.mkt_ranking_objectives' ? (f.fijos ?? []) : [];
    const b: Record<string, unknown> = {};
    for (const m of ['whereNull', 'whereNotNull', 'select', 'orderBy', 'whereBetween', 'whereIn', 'where']) b[m] = () => b;
    b['first'] = () => Promise.resolve(undefined);
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, ko);
    return b;
  };
  const trx = Object.assign((t: string) => builder(t), { raw, fn: { now: () => 'now()' } });
  return { trx, consultas };
}

function svcCon(trx: unknown, productos: string[] = ['R1']) {
  const svc = new MktRankingService(
    { run: (fn: (t: unknown) => unknown) => fn(trx) } as never,
    { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
  );
  const ident: ProductosDePromo = {
    metodo: productos.length ? 'ticket_y_nombre' : 'sin_identificar', tickets: 10,
    productos: productos.map((sku) => ({ sku, nombre: `PRODUCTO ${sku}`, tickets: 10, pct: 1 })), nota: '',
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).productosConCache = () => Promise.resolve(new Map([['62253', ident]]));
  return svc;
}

/** Una línea de Kepler ya agregada por ticket y SKU (la forma de la consulta de `venta`). */
const linea = (x: Fila): Fila => ({ canal: 'mostrador', warehouse_code: '01', doc_tipo: 4, caja: '1 ', folio: '100', vendor_code: '', vendor_name: null, qty: 0, importe: 0, ...x });

const BASE: Fake = {
  keplerLineas: [
    // Ticket 100 (mostrador): asignado por la cajera a P7.
    linea({ folio: '100', sku: '62253', qty: 2, importe: 0.02 }),
    linea({ folio: '100', sku: 'R1', qty: 6, importe: 150 }),
    // Ticket 101 (mostrador): nadie lo asignó.
    linea({ folio: '101', sku: '62253', qty: 1, importe: 0.01 }),
    linea({ folio: '101', sku: 'R1', qty: 3, importe: 75 }),
    // Vecinal: ruta 1V001 de la sucursal 01.
    linea({ canal: 'preventa', folio: '900', doc_tipo: 2, vendor_code: '01:1V001', vendor_name: 'RUTA VECINAL CENTRO', sku: '62253', qty: 4, importe: 0.04 }),
    linea({ canal: 'preventa', folio: '900', doc_tipo: 2, vendor_code: '01:1V001', vendor_name: 'RUTA VECINAL CENTRO', sku: 'R1', qty: 12, importe: 300 }),
  ],
  // La cajera escribe el folio sin espacios y la caja con ellos: la llave los recorta igual.
  asignadas: [{ warehouse_code: '01', doc_tipo: 4, caja: '1', folio: '100 ', person_code: 'P7', person_name: 'VENDEDORA DEMO' }],
  asignacionRutas: [{ sucursal: '01', codigo: '1V001', etiqueta: 'RUTA VECINAL', nombre: 'VENDEDOR VECINAL DEMO', dias: 6 }],
};

describe('[MKT.30] venta(): ranking de promociones', () => {
  it('toda la venta de los canales, con su dinero (lo cobrado de sus productos)', async () => {
    const r = await svcCon(fakeTrx(BASE).trx).venta('2026-11-09', {});
    expect(r.promos).toHaveLength(1);
    expect(r.promos[0]).toMatchObject({ code: '62253', paquetes: 7, dinero: 525, productos_metodo: 'ticket_y_nombre', productos_nombres: ['PRODUCTO R1'] });
    expect(r.promos[0].por_canal).toEqual([{ canal: 'mostrador', paquetes: 3, dinero: 225 }, { canal: 'preventa', paquetes: 4, dinero: 300 }]);
    expect(r.totales).toMatchObject({ paquetes: 7, dinero: 525, promos: 1, promos_sin_dato: 0 });
    expect(r.sucursal_top).toMatchObject({ warehouse_code: '01', zona: 'LA PIEDAD RD', paquetes: 7 });
    expect(r.dinero_contrastado).toEqual({ mostrador: true, preventa: false, ruta: false, mayoreo: false });
  });

  it('[MKT.27] trae los códigos de barras del producto (pistola) y sus SKU; si no se leen, null (no se cae)', async () => {
    const r = await svcCon(fakeTrx(BASE).trx).venta('2026-11-09', {});
    expect(r.codigos_barras).toEqual({ R1: ['7501000000017'] });
    expect(r.promos[0].productos_skus).toEqual(['R1']);
    const mal = await svcCon(fakeTrx({ ...BASE, barrasTruena: true }).trx).venta('2026-11-09', {});
    expect(mal.codigos_barras).toBeNull();
    expect(mal.promos[0].paquetes).toBe(7);
  });

  it('sin producto identificado: paquetes sí, dinero «sin dato» (null), nunca 0', async () => {
    const r = await svcCon(fakeTrx(BASE).trx, []).venta('2026-11-09', {});
    expect(r.promos[0].paquetes).toBe(7);
    expect(r.promos[0].dinero).toBeNull();
    expect(r.totales.promos_sin_dato).toBe(1);
  });

  it('Ruta directa: la camioneta entra con su folio como ticket, en la sucursal padre; sin zona = «Sin zona»', async () => {
    const camionetasLineas = [
      { warehouse_code: '04', vendor_code: 'ruta:21', source_branch: '21', doc_ref: 'T55 ', sku: '62253', qty: 5, importe: 0.05 },
      { warehouse_code: '04', vendor_code: 'ruta:21', source_branch: '21', doc_ref: 'T55', sku: 'R1', qty: 10, importe: 200 },
    ];
    const r = await svcCon(fakeTrx({ ...BASE, camionetasLineas }).trx).venta('2026-11-09', { canal: 'ruta' });
    expect(r.promos[0]).toMatchObject({ paquetes: 5, dinero: 200 });
    expect(r.promos[0].por_sucursal).toEqual([expect.objectContaining({ warehouse_code: '04', zona: 'Sin zona', paquetes: 5 })]);
    const v = r.vendedores[0];
    expect(v).toMatchObject({ canal: 'ruta', nombre: 'Ruta 21', fuente: 'sin_dato', paquetes: 5, total: 200 });
    expect(v.detalle).toContain('Camioneta 21');
    expect(r.zonas_lista).toContain('Sin zona');
  });

  it('pasa los 4 canales y los SKU de la promo y de su producto a la consulta de líneas', async () => {
    const { trx, consultas } = fakeTrx(BASE);
    await svcCon(trx).venta('2026-11-09', {});
    const q = consultas.find((c) => /WITH tk AS MATERIALIZED/.test(c.sql) && /v_kepler_sales_lines/.test(c.sql))!;
    expect(q.params[2]).toEqual(['mostrador', 'preventa', 'ruta', 'mayoreo']);
    expect(q.params[3]).toEqual(['62253']);
    expect(q.params[7]).toEqual(['62253', 'R1']);
  });
});

describe('[MKT.30] venta(): objetivo por sucursal (botón «Objetivos»)', () => {
  const UUID = '11111111-2222-3333-4444-555555555555';
  const registradas = [{ id: UUID, code: '62253', activo: true, mecanica: '', objetivos: 2, updated_at: new Date() }];
  const fijo = (w: string, v: number, canal = 'mostrador') => ({ promo_id: UUID, warehouse_code: w, canal, vendor_code: '', objetivo_semanal: v });
  const conDos = { ...BASE, keplerLineas: [...BASE.keplerLineas, linea({ warehouse_code: '04', folio: '300', sku: '62253', qty: 1 })] };

  it('sin nada fijado: fijo null, y las sucursales donde se vende en mostrador', async () => {
    const r = await svcCon(fakeTrx(conDos).trx).venta('2026-11-09', {});
    expect(r.promos[0].objetivo_sucursal).toEqual({ fijo: null, mixto: false, automatico: null, sucursales: ['01', '04'] });
  });

  it('el mismo valor en todas sus sucursales: ése es el fijo, y suma al objetivo de la promo', async () => {
    const r = await svcCon(fakeTrx({ ...conDos, registradas, fijos: [fijo('01', 5), fijo('04', 5)] }).trx).venta('2026-11-09', {});
    expect(r.promos[0].objetivo_sucursal).toMatchObject({ fijo: 5, mixto: false });
    expect(r.promos[0].objetivo).toBe(10);
  });

  it('[negativa] valores distintos o una sucursal sin fijar: no se inventa un fijo, se dice «mixto»', async () => {
    const distintos = await svcCon(fakeTrx({ ...conDos, registradas, fijos: [fijo('01', 5), fijo('04', 8)] }).trx).venta('2026-11-09', {});
    expect(distintos.promos[0].objetivo_sucursal).toMatchObject({ fijo: null, mixto: true });
    const falta = await svcCon(fakeTrx({ ...conDos, registradas, fijos: [fijo('01', 5)] }).trx).venta('2026-11-09', {});
    expect(falta.promos[0].objetivo_sucursal).toMatchObject({ fijo: null, mixto: true });
  });
});

describe('[MKT.30] venta(): ranking de vendedores (lo cargado)', () => {
  it('⭐ mostrador: sólo el ticket que la cajera asignó, con el nombre que escribió; lo demás se cuenta aparte', async () => {
    const r = await svcCon(fakeTrx(BASE).trx).venta('2026-11-09', { canal: 'mostrador' });
    expect(r.vendedores).toHaveLength(1);
    expect(r.vendedores[0]).toMatchObject({
      nombre: 'VENDEDORA DEMO', fuente: 'cajera', canal: 'mostrador', paquetes: 2, total: 150,
      detalle: 'Padre Hidalgo · le asignaron 1 ticket',
    });
    expect(r.vendedores[0].promos).toEqual([{ code: '62253', nombre: '3 PROD LA ROSA = GRATIS 1', paquetes: 2, precio: 75, total: 150 }]);
    expect(r.mostrador).toEqual({ tickets_con_promo: 2, tickets_asignados: 1 });
  });

  it('[negativa] sin asignaciones de la cajera, el mostrador no tiene vendedores (no se adivina)', async () => {
    const r = await svcCon(fakeTrx({ ...BASE, asignadas: [] }).trx).venta('2026-11-09', { canal: 'mostrador' });
    expect(r.vendedores).toEqual([]);
    expect(r.mostrador).toEqual({ tickets_con_promo: 2, tickets_asignados: 0 });
  });

  it('Vecinal: la persona asignada a la ruta en la Suite, con la ruta debajo', async () => {
    const r = await svcCon(fakeTrx(BASE).trx).venta('2026-11-09', { canal: 'preventa' });
    expect(r.vendedores[0]).toMatchObject({ nombre: 'VENDEDOR VECINAL DEMO', fuente: 'asignacion', paquetes: 4, total: 300 });
    expect(r.vendedores[0].detalle).toBe('Ruta 1V001 · Padre Hidalgo');
  });

  it('Vecinal sin ruta ligada: el nombre de Kepler, dicho como tal', async () => {
    const r = await svcCon(fakeTrx({ ...BASE, asignacionRutas: [] }).trx).venta('2026-11-09', { canal: 'preventa' });
    expect(r.vendedores[0]).toMatchObject({ nombre: 'RUTA VECINAL CENTRO', fuente: 'kepler' });
  });
});
