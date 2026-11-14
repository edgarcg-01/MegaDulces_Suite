import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MktRankingService, listaProveedores, proveedorDelProducto, SIN_PROVEEDOR } from './mkt-ranking.service';
import type { ProductosDePromo } from './mkt-ranking.logic';
import type { Semana } from './mkt-ranking.logic';

/**
 * `[MKT.24]` El proveedor de cada promoción lo asigna Mercadotecnia (Kepler sólo trae la cubeta
 * «PROMOCIONES MKT»), y el ranking se filtra por él. La base se simula: cada consulta se reconoce
 * por la tabla que lee. Se prueban las reglas, no el SQL.
 */

const PROMO = '7afca9a3-6d1a-4130-870b-1f2d6e1c314a';
const PROV_A = '11111111-2222-4333-8444-555555555555';
const PROV_B = '99999999-2222-4333-8444-555555555555';

interface Fake {
  catalogo?: Array<{ code: string; nombre: string | null }>;
  semana?: Array<Record<string, unknown>>;
  registradas?: Array<Record<string, unknown>>;
  proveedores?: Array<Record<string, unknown>>;
  /** Simula el código desplegado ANTES que su migración: el UPDATE de supplier_id truena. */
  sinColumna?: boolean;
  /** El proveedor de cada producto (catalog.products ⨝ catalog.suppliers). */
  provDeProducto?: Array<{ sku: string; id: string; code: string; name: string }>;
}

function fakeTrx(f: Fake) {
  const log = {
    raw: [] as Array<{ sql: string; params: unknown[] }>,
    inserts: [] as Array<{ tabla: string; fila: Record<string, unknown> }>,
    updates: [] as Array<{ tabla: string; filtro: Record<string, unknown>; set: Record<string, unknown> }>,
  };
  const raw = (sql: string, params: unknown[] = []) => {
    log.raw.push({ sql, params });
    if (/JOIN catalog\.suppliers/.test(sql)) {
      const skus = params[0] as string[];
      return Promise.resolve({ rows: (f.provDeProducto ?? []).filter((x) => skus.includes(x.sku)) });
    }
    if (/FROM catalog\.products/.test(sql) && /GROUP BY 1/.test(sql)) return Promise.resolve({ rows: f.catalogo ?? [] });
    if (/FROM catalog\.products/.test(sql)) {
      const c = (f.catalogo ?? []).find((x) => x.code === params[0]);
      return Promise.resolve({ rows: c ? [{ nombre: c.nombre }] : [] });
    }
    if (/v_kepler_sales_lines/.test(sql) && /min\(business_date\)/.test(sql)) {
      const canales = params[params.length - 1] as string[];
      return Promise.resolve({ rows: (f.semana ?? []).filter((r) => canales.includes(String(r['canal']))) });
    }
    return Promise.resolve({ rows: [] });
  };
  const builder = (tabla: string) => {
    let filtro: Record<string, unknown> = {};
    let ids: unknown[] | null = null;
    const filas = (): Array<Record<string, unknown>> => {
      if (tabla.startsWith('commercial.mkt_ranking_promos')) {
        return (f.registradas ?? []).filter((r) => Object.entries(filtro).every(([k, v]) => r[k] === v));
      }
      if (tabla === 'catalog.suppliers') {
        return (f.proveedores ?? []).filter((p) => (!ids || ids.includes(p['id'])) && Object.entries(filtro).every(([k, v]) => p[k] === v));
      }
      return [];
    };
    const b: Record<string, unknown> = {};
    for (const m of ['whereNull', 'whereNotNull', 'select', 'orderBy', 'whereBetween']) b[m] = () => b;
    b['whereIn'] = (_c: string, v: unknown[]) => { ids = v; return b; };
    b['where'] = (x: unknown, v?: unknown) => {
      if (x && typeof x === 'object') filtro = { ...filtro, ...(x as Record<string, unknown>) };
      else if (typeof x === 'string' && v !== undefined) filtro = { ...filtro, [x]: v };
      return b;
    };
    b['first'] = () => Promise.resolve(filas()[0]);
    b['insert'] = (fila: Record<string, unknown>) => { log.inserts.push({ tabla, fila }); return b; };
    b['returning'] = () => Promise.resolve([{ id: 'nuevo-uuid' }]);
    b['update'] = (set: Record<string, unknown>) => {
      if (f.sinColumna && 'supplier_id' in set) return Promise.reject(new Error('column "supplier_id" of relation "mkt_ranking_promos" does not exist'));
      log.updates.push({ tabla, filtro: { ...filtro }, set });
      return Promise.resolve(1);
    };
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas()).then(ok, ko);
    return b;
  };
  const trx = Object.assign((tabla: string) => builder(tabla), { raw, fn: { now: () => 'now()' } });
  return { trx, log };
}

const svcCon = (trx: unknown) => new MktRankingService(
  { run: (fn: (t: unknown) => unknown) => fn(trx) } as never,
  { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (svc: MktRankingService) => svc as any;

const semana: Semana = { lunes: '2026-11-02', domingo: '2026-11-08', numero: 45, hasta: '2026-11-08', en_curso: false };
const catalogo = [
  { code: '09066', nombre: '3 LECHES = GRATIS 1' },
  { code: '00154', nombre: '2 PROD BONDY = GRATIS 1 HUEVO' },
];
const vendieron = [
  { canal: 'mostrador', sku: '09066', warehouse_code: '03', primera: new Date('2026-11-03T00:00:00Z') },
  { canal: 'mostrador', sku: '00154', warehouse_code: '03', primera: new Date('2026-11-03T00:00:00Z') },
];
const proveedores = [
  { id: PROV_A, code: 'CD015', name: 'DULCES DE PRUEBA SA', activo: true },
  { id: PROV_B, code: 'CX001', name: 'PROVEEDOR INACTIVO', activo: false },
];

describe('[MKT.24] el proveedor de cada promoción', () => {
  it('⭐ la promo con proveedor asignado lo trae con su clave y nombre; la que no, sale null', async () => {
    const { trx } = fakeTrx({ catalogo, semana: vendieron, proveedores, registradas: [{ id: PROMO, code: '09066', activo: true, supplier_id: PROV_A }] });
    const ps = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    const de = (c: string) => ps.find((p: { code: string }) => p.code === c);
    expect(de('09066').proveedor).toEqual({ id: PROV_A, code: 'CD015', name: 'DULCES DE PRUEBA SA' });
    expect(de('00154').proveedor).toBeNull();
  });

  it('[negativa] antes de aplicar la migración (sin columna) no truena: todas salen sin proveedor y no se consulta catalog.suppliers', async () => {
    const { trx } = fakeTrx({ catalogo, semana: vendieron, proveedores, registradas: [{ id: PROMO, code: '09066', activo: true }] });
    const ps = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    expect(ps.every((p: { proveedor: unknown }) => p.proveedor === null)).toBe(true);
  });

  it('la lista del filtro cuenta por proveedor, por nombre, y «Sin proveedor asignado» va al final', () => {
    const a = { id: PROV_A, code: 'CD015', name: 'ZETA' };
    const b = { id: PROV_B, code: 'CA001', name: 'ALFA' };
    expect(listaProveedores([{ proveedor: a }, { proveedor: null }, { proveedor: b }, { proveedor: a }, {}])).toEqual([
      { ...b, promos: 1 }, { ...a, promos: 2 }, { id: null, code: null, name: 'Sin proveedor asignado', promos: 2 },
    ]);
    expect(listaProveedores([])).toEqual([]);
  });
});

describe('[MKT.24] asignar el proveedor', () => {
  it('⭐ a una promo de Kepler sin renglón: crea el renglón (bajo candado) y le pone el proveedor', async () => {
    const { trx, log } = fakeTrx({ catalogo, proveedores });
    const r = await svcCon(trx).asignarProveedor('k-09066', PROV_A, { id: 'u1', username: 'mkt' });
    expect(r.proveedor).toEqual({ id: PROV_A, code: 'CD015', name: 'DULCES DE PRUEBA SA' });
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].fila).toMatchObject({ code: '09066' });
    expect(log.raw.some((x) => /pg_advisory_xact_lock/.test(x.sql))).toBe(true);
    expect(log.updates).toHaveLength(1);
    expect(log.updates[0]).toMatchObject({ filtro: { id: 'nuevo-uuid' }, set: { supplier_id: PROV_A, updated_by_username: 'mkt' } });
  });

  it('a una promo con renglón: sólo actualiza, no crea otro', async () => {
    const { trx, log } = fakeTrx({ catalogo, proveedores, registradas: [{ id: PROMO, code: '09066' }] });
    await svcCon(trx).asignarProveedor(PROMO, PROV_A, {});
    expect(log.inserts).toEqual([]);
    expect(log.updates[0]).toMatchObject({ filtro: { id: PROMO }, set: { supplier_id: PROV_A } });
  });

  it('quitarlo (null) a una promo con renglón deja supplier_id en null', async () => {
    const { trx, log } = fakeTrx({ catalogo, proveedores, registradas: [{ id: PROMO, code: '09066', supplier_id: PROV_A }] });
    expect(await svcCon(trx).asignarProveedor(PROMO, null, {})).toEqual({ proveedor: null });
    expect(log.updates[0].set['supplier_id']).toBeNull();
  });

  it('[negativa] quitarlo a una promo de Kepler sin renglón no crea nada', async () => {
    const { trx, log } = fakeTrx({ catalogo, proveedores });
    expect(await svcCon(trx).asignarProveedor('k-09066', null, {})).toEqual({ proveedor: null });
    expect(log.inserts).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  it('[negativas] proveedor mal formado → 400; inexistente o inactivo → 404, sin escribir', async () => {
    const { trx, log } = fakeTrx({ catalogo, proveedores, registradas: [{ id: PROMO, code: '09066' }] });
    await expect(svcCon(trx).asignarProveedor(PROMO, 'no-es-uuid', {})).rejects.toThrow(BadRequestException);
    await expect(svcCon(trx).asignarProveedor(PROMO, '00000000-0000-4000-8000-000000000000', {})).rejects.toThrow(NotFoundException);
    await expect(svcCon(trx).asignarProveedor(PROMO, PROV_B, {})).rejects.toThrow(NotFoundException);
    expect(log.updates).toEqual([]);
  });

  it('[negativa] código desplegado antes que la migración → 503 que dice qué falta, no un 500 mudo', async () => {
    const { trx } = fakeTrx({ catalogo, proveedores, registradas: [{ id: PROMO, code: '09066' }], sinColumna: true });
    await expect(svcCon(trx).asignarProveedor(PROMO, PROV_A, {})).rejects.toThrow(ServiceUnavailableException);
    await expect(svcCon(trx).asignarProveedor(PROMO, PROV_A, {})).rejects.toThrow(/migración/);
  });
});

describe('[MKT.24] el ranking filtrado por proveedor', () => {
  const datos: Fake = { catalogo, semana: vendieron, proveedores, registradas: [{ id: PROMO, code: '09066', activo: true, supplier_id: PROV_A }] };

  it('⭐ con proveedor: el ranking se calcula sólo con sus promos; la lista del filtro sigue completa', async () => {
    const { trx } = fakeTrx(datos);
    const r = await svcCon(trx).ranking('2026-11-02', 'mostrador', undefined, undefined, PROV_A);
    expect(r.promos_ranking.map((p) => p.code)).toEqual(['09066']);
    expect(r.promos_ranking[0].proveedor?.code).toBe('CD015');
    expect(r.promos_lista.map((p) => p.code).sort()).toEqual(['00154', '09066']);
    expect(r.promos_lista.find((p) => p.code === '09066')?.proveedor_id).toBe(PROV_A);
    expect(r.proveedores_lista.map((p) => [p.id, p.promos])).toEqual([[PROV_A, 1], [null, 1]]);
    expect(r.proveedor_filtrado).toBe(PROV_A);
  });

  it('«sin» deja sólo las que nadie ha asignado', async () => {
    const { trx } = fakeTrx(datos);
    const r = await svcCon(trx).ranking('2026-11-02', 'mostrador', undefined, undefined, SIN_PROVEEDOR);
    expect(r.promos_ranking.map((p) => p.code)).toEqual(['00154']);
  });

  it('[control] sin filtro entran las dos', async () => {
    const { trx } = fakeTrx(datos);
    const r = await svcCon(trx).ranking('2026-11-02', 'mostrador');
    expect(r.promos_ranking.map((p) => p.code).sort()).toEqual(['00154', '09066']);
    expect(r.proveedor_filtrado).toBeNull();
  });
});

describe('[MKT.24] el proveedor del PRODUCTO, cuando nadie lo asignó', () => {
  const A = { id: PROV_A, code: 'CH001', name: 'HERSHEY DEMO' };
  const B = { id: PROV_B, code: 'CB001', name: 'BARCEL DEMO' };

  it('un solo proveedor en todos sus productos → ése; dos distintos, uno sin proveedor o ninguno → null (no se adivina)', () => {
    expect(proveedorDelProducto([A, A])).toEqual(A);
    expect(proveedorDelProducto([A, B])).toBeNull();
    expect(proveedorDelProducto([A, null])).toBeNull();
    expect(proveedorDelProducto([A, undefined])).toBeNull();
    expect(proveedorDelProducto([])).toBeNull();
  });

  const ident = (metodo: ProductosDePromo['metodo'], skus: string[]): ProductosDePromo =>
    ({ metodo, tickets: 30, nota: '', productos: skus.map((sku) => ({ sku, nombre: sku, tickets: 10, pct: 30 })) });

  it('⭐ sin asignar: toma el del producto identificado por ticket y nombre, marcado «producto»', async () => {
    const { trx } = fakeTrx({ provDeProducto: [{ sku: 'P1', ...A }, { sku: 'P2', ...A }] });
    const [p] = await priv(svcCon(trx)).conProveedorDelProducto(trx, [{ code: '00108', proveedor: null }], new Map([['00108', ident('ticket_y_nombre', ['P1', 'P2'])]]));
    expect(p.proveedor).toEqual(A);
    expect(p.proveedor_fuente).toBe('producto');
  });

  it('[negativa] lo ASIGNADO gana: no se reemplaza por el del producto', async () => {
    const { trx, log } = fakeTrx({ provDeProducto: [{ sku: 'P1', ...B }] });
    const [p] = await priv(svcCon(trx)).conProveedorDelProducto(trx, [{ code: '00108', proveedor: A, proveedor_fuente: 'asignado' }], new Map([['00108', ident('ticket_y_nombre', ['P1'])]]));
    expect(p.proveedor).toEqual(A);
    expect(p.proveedor_fuente).toBe('asignado');
    expect(log.raw.some((x) => /JOIN catalog\.suppliers/.test(x.sql))).toBe(false);
  });

  it('[negativa] «mismo_codigo» (el producto es el propio código de la promo, de la cubeta) no da proveedor', async () => {
    const { trx } = fakeTrx({ provDeProducto: [{ sku: '00108', ...A }] });
    const [p] = await priv(svcCon(trx)).conProveedorDelProducto(trx, [{ code: '00108', proveedor: null }], new Map([['00108', ident('mismo_codigo', ['00108'])]]));
    expect(p.proveedor).toBeNull();
  });

  it('[negativa] productos de dos proveedores → sigue sin proveedor', async () => {
    const { trx } = fakeTrx({ provDeProducto: [{ sku: 'P1', ...A }, { sku: 'P2', ...B }] });
    const [p] = await priv(svcCon(trx)).conProveedorDelProducto(trx, [{ code: '00108', proveedor: null }], new Map([['00108', ident('ticket_y_nombre', ['P1', 'P2'])]]));
    expect(p.proveedor).toBeNull();
    expect(p.proveedor_fuente).toBeUndefined();
  });
});
