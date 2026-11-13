import { NotFoundException } from '@nestjs/common';
import { MktRankingService, esIdPromo, idKepler } from './mkt-ranking.service';
import { MktVendedorasService } from './mkt-vendedoras.service';
import type { Semana } from './mkt-ranking.logic';

/**
 * `[MKT.22]`–`[MKT.23]` Las promociones salen de KEPLER (`catalog.products.is_promo`), no de un alta.
 * La base se simula: cada consulta se reconoce por la tabla que lee y devuelve filas fijas. Se
 * prueban las REGLAS (qué entra, con qué id, en qué sucursales, desde cuándo), no el SQL.
 */

const UUID = '7afca9a3-6d1a-4130-870b-1f2d6e1c314a';

interface Fake {
  catalogo?: Array<{ code: string; nombre: string | null }>;
  semana?: Array<Record<string, unknown>>;
  hist?: Array<Record<string, unknown>>;
  registradas?: Array<Record<string, unknown>>;
  ventas?: Array<Record<string, unknown>>;
  personas?: Array<Record<string, unknown>>;
  asignados?: Array<Record<string, unknown>>;
}

/** Un `trx` de knex de mentira: `raw` por la tabla que lee; `trx(tabla)` encadena y resuelve filas. */
function fakeTrx(f: Fake) {
  const log = { raw: [] as Array<{ sql: string; params: unknown[] }>, inserts: [] as Array<{ tabla: string; fila: Record<string, unknown> }> };
  const raw = (sql: string, params: unknown[] = []) => {
    log.raw.push({ sql, params });
    if (/pg_advisory_xact_lock/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM catalog\.products/.test(sql) && /GROUP BY 1/.test(sql)) return Promise.resolve({ rows: f.catalogo ?? [] });
    if (/FROM catalog\.products/.test(sql)) {
      const c = (f.catalogo ?? []).find((x) => x.code === params[0]);
      return Promise.resolve({ rows: c ? [{ nombre: c.nombre }] : [] });
    }
    // Como el SQL: sólo los canales pedidos (el último parámetro).
    const enCanal = (rows: Array<Record<string, unknown>>) => rows.filter((r) => (params[params.length - 1] as string[]).includes(String(r['canal'])));
    if (/mv_kepler_sales_daily/.test(sql)) return Promise.resolve({ rows: enCanal(f.hist ?? []) });
    if (/hr\.attendance_logs/.test(sql)) return Promise.resolve({ rows: f.personas ?? [] });
    if (/v_kepler_sales_lines/.test(sql) && /kdpv_folio_caja/.test(sql)) return Promise.resolve({ rows: f.ventas ?? [] });
    if (/v_kepler_sales_lines/.test(sql)) return Promise.resolve({ rows: enCanal(f.semana ?? []) });
    return Promise.resolve({ rows: [] });
  };
  const builder = (tabla: string) => {
    let filtro: Record<string, unknown> = {};
    const filas = () => {
      if (tabla.startsWith('commercial.mkt_ranking_promos')) {
        return (f.registradas ?? []).filter((r) => Object.entries(filtro).every(([k, v]) => r[k] === v));
      }
      if (tabla === 'commercial.mkt_promo_ticket_sellers') return f.asignados ?? [];
      return [];
    };
    const b: Record<string, unknown> = {};
    for (const m of ['whereNull', 'select', 'orderBy', 'whereBetween', 'whereIn']) b[m] = () => b;
    b['where'] = (x: unknown) => { if (x && typeof x === 'object') filtro = { ...filtro, ...(x as Record<string, unknown>) }; return b; };
    b['first'] = () => Promise.resolve(filas()[0]);
    b['insert'] = (fila: Record<string, unknown>) => { log.inserts.push({ tabla, fila }); return b; };
    b['returning'] = () => Promise.resolve([{ id: 'nuevo-uuid' }]);
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(filas()).then(ok, ko);
    return b;
  };
  const trx = Object.assign((tabla: string) => builder(tabla), { raw, fn: { now: () => 'now()' } });
  return { trx, log };
}

const semana: Semana = { lunes: '2026-11-02', domingo: '2026-11-08', numero: 45, hasta: '2026-11-08', en_curso: false };
const svcCon = (trx: unknown) => new MktRankingService(
  { run: (fn: (t: unknown) => unknown) => fn(trx) } as never,
  { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (svc: MktRankingService) => svc as any;

const catalogo = [
  { code: '09066', nombre: '3 LECHES = GRATIS 1' },
  { code: '00110', nombre: '1 CJ SHUSHARASHA = GRATIS 1 BLS' },
  { code: '27100', nombre: '2 EXH WAFER = GRATIS 1' },
  { code: '00154', nombre: '2 PROD BONDY = GRATIS 1 HUEVO' },
];

describe('[MKT.22] las promociones de la semana salen de Kepler', () => {
  const base: Fake = {
    catalogo,
    // La semana (la línea): 09066 en 03; 00110 sólo en preventa.
    semana: [
      { canal: 'mostrador', sku: '09066', warehouse_code: '03', primera: new Date('2026-11-03T00:00:00Z') },
      { canal: 'preventa', sku: '00110', warehouse_code: '01', primera: new Date('2026-11-04T00:00:00Z') },
    ],
    // Las 4 semanas previas (la matview): 09066 también en 05 desde el 20-oct; 27100 vendió antes pero NO esta semana.
    hist: [
      { canal: 'mostrador', sku: '09066', warehouse_code: '05', primera: new Date('2026-10-20T00:00:00Z'), en_ventana: false },
      { canal: 'mostrador', sku: '27100', warehouse_code: '02', primera: new Date('2026-10-13T00:00:00Z'), en_ventana: false },
    ],
  };

  it('⭐ entra lo que VENDIÓ esa semana en ese canal; nadie la dio de alta (id k-<código>)', async () => {
    const { trx } = fakeTrx(base);
    const ps = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    expect(ps.map((p: { code: string }) => p.code)).toEqual(['09066']);
    expect(ps[0].id).toBe(idKepler('09066'));
    expect(ps[0].mecanica).toBe('3 LECHES = GRATIS 1');
    expect(ps[0].canales).toEqual(['mostrador']);
  });

  it('[negativa] vendió antes pero no esta semana → no entra (27100); vendió en otro canal → no entra (00110)', async () => {
    const { trx } = fakeTrx(base);
    const ps = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    expect(ps.find((p: { code: string }) => p.code === '27100')).toBeUndefined();
    expect(ps.find((p: { code: string }) => p.code === '00110')).toBeUndefined();
  });

  it('cuenta en las sucursales donde vendió (la semana o las 4 previas) y empieza en su primera venta', async () => {
    const { trx } = fakeTrx(base);
    const [p] = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    expect(p.warehouse_codes).toEqual(['03', '05']);
    expect(p.vigencia_desde).toBe('2026-10-20');
  });

  it('una promo nueva (sin historia) empieza el lunes de la semana: el dinámico no promedia ceros de antes', async () => {
    const { trx } = fakeTrx({ ...base, hist: [] });
    const [p] = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    expect(p.vigencia_desde).toBe('2026-11-02');
    expect(p.warehouse_codes).toEqual(['03']);
  });

  it('con renglón propio usa SU id (la llave de los objetivos) y su nombre; activo=false la saca', async () => {
    const reg = { id: UUID, code: '09066', mecanica: 'Leche San Juan', activo: true, objetivos: 3, updated_at: new Date() };
    let { trx } = fakeTrx({ ...base, registradas: [reg] });
    const [p] = await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador');
    expect(p.id).toBe(UUID);
    expect(p.mecanica).toBe('Leche San Juan');
    expect(p.descripcion_kepler).toBe('3 LECHES = GRATIS 1');
    expect(p.objetivos).toBe(3);
    ({ trx } = fakeTrx({ ...base, registradas: [{ ...reg, activo: false }] }));
    expect(await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador')).toEqual([]);
  });

  it('la lista de Objetivos (ventana de 5 semanas) incluye lo que vendió en la ventana aunque no esta semana', async () => {
    const { trx, log } = fakeTrx({ ...base, semana: [], hist: [{ ...base.hist![1], en_ventana: true }] });
    const ps = await priv(svcCon(trx)).promosVigentes(trx, semana, undefined, { ventanaSemanas: 5 });
    expect(ps.map((p: { code: string }) => p.code)).toEqual(['27100']);
    // Con ventana larga no se consulta la línea (sólo la matview).
    expect(log.raw.some((r) => /v_kepler_sales_lines/.test(r.sql))).toBe(false);
  });

  it('[negativa] sin promociones en el catálogo → lista vacía, sin consultar la venta', async () => {
    const { trx, log } = fakeTrx({ catalogo: [] });
    expect(await priv(svcCon(trx)).promosVigentes(trx, semana, 'mostrador')).toEqual([]);
    expect(log.raw.some((r) => /v_kepler_sales_lines|mv_kepler_sales_daily/.test(r.sql))).toBe(false);
  });
});

describe('[MKT.22] objetivos de una promo de Kepler', () => {
  it('k-<código> sin renglón: leer no crea nada y devuelve null', async () => {
    const { trx, log } = fakeTrx({ catalogo });
    expect(await priv(svcCon(trx)).promoIdParaObjetivos(trx, 'k-09066', false)).toBeNull();
    expect(log.inserts).toEqual([]);
  });

  it('⭐ al fijar el primer objetivo crea el renglón con el nombre de Kepler, bajo candado por código', async () => {
    const { trx, log } = fakeTrx({ catalogo });
    const id = await priv(svcCon(trx)).promoIdParaObjetivos(trx, 'k-09066', true, { id: 'u1', username: 'mkt' });
    expect(id).toBe('nuevo-uuid');
    expect(log.raw.find((r) => /pg_advisory_xact_lock/.test(r.sql))?.params).toEqual(['mkt_ranking_promo:09066']);
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].fila).toMatchObject({ code: '09066', mecanica: '3 LECHES = GRATIS 1', activo: true, created_by_username: 'mkt' });
  });

  it('k-<código> que ya tiene renglón: usa ése, no crea otro', async () => {
    const { trx, log } = fakeTrx({ catalogo, registradas: [{ id: UUID, code: '09066' }] });
    expect(await priv(svcCon(trx)).promoIdParaObjetivos(trx, 'k-09066', true)).toBe(UUID);
    expect(log.inserts).toEqual([]);
  });

  it('[negativas] un código que no es promo de Kepler, o un UUID que no existe → 404', async () => {
    const { trx } = fakeTrx({ catalogo });
    await expect(priv(svcCon(trx)).promoIdParaObjetivos(trx, 'k-99999', true)).rejects.toThrow(NotFoundException);
    await expect(priv(svcCon(trx)).promoIdParaObjetivos(trx, UUID, false)).rejects.toThrow(NotFoundException);
  });

  it('guardar sólo QUITAR objetivos de una promo sin renglón no crea el renglón', async () => {
    const { trx, log } = fakeTrx({ catalogo });
    const r = await svcCon(trx).guardarObjetivos('k-09066', [{ warehouse_code: '03', canal: 'mostrador', vendor_code: '', objetivo_semanal: null }] as never, {});
    expect(r).toEqual({ guardados: 0, quitados: 0 });
    expect(log.inserts).toEqual([]);
  });

  it('el id de una promo: UUID o k-<código>; lo demás se rechaza', () => {
    expect(esIdPromo(UUID)).toBe(true);
    expect(esIdPromo('k-09066')).toBe(true);
    expect(esIdPromo('k-')).toBe(false);
    expect(esIdPromo('09066')).toBe(false);
    expect(esIdPromo('k-09066/../x')).toBe(false);
  });
});

describe('[MKT.23] ¿Quién vendió? — promos de Kepler y toda la sucursal', () => {
  const ticket = (folio: string, cajero: string, sku = '09066') => ({
    doc_tipo: 10, caja: '91', folio, business_date: new Date('2026-11-10T00:00:00Z'), total_documento: 120, sku, qty: 2, apertura: '900123', cajero,
  });
  const vendSvc = (trx: unknown) => new MktVendedorasService(
    { run: (fn: (t: unknown) => unknown) => fn(trx) } as never,
    { requireTenantId: () => 't' } as never,
    { assertCanWrite: async () => undefined, current: async () => ({ dims: { warehouse: { modeWrite: 'list', valuesWrite: ['03'] } } }) } as never,
  );

  it('⭐ trae los tickets de TODAS las cajas de la sucursal, aunque el usuario no sea el cajero', async () => {
    const { trx } = fakeTrx({ catalogo, ventas: [ticket('A1', '40AMMV'), ticket('A2', '40VMC'), ticket('A3', 'C01', '00154')] });
    const r = await vendSvc(trx).tickets('03', '7', 'OTRO_USUARIO', false);
    expect(r.tickets.map((t) => t.folio).sort()).toEqual(['A1', 'A2', 'A3']);
    expect(r.ve_toda_la_sucursal).toBe(true);
    expect(new Set(r.tickets.map((t) => t.cajero))).toEqual(new Set(['40AMMV', '40VMC', 'C01']));
  });

  it('el nombre de la promoción sale del catálogo de Kepler y se buscan TODOS sus códigos', async () => {
    const { trx, log } = fakeTrx({ catalogo, ventas: [ticket('A1', 'C01')] });
    const r = await vendSvc(trx).tickets('03', '7', 'C01', false);
    expect(r.tickets[0].promos).toEqual([{ code: '09066', mecanica: '3 LECHES = GRATIS 1', cantidad: 2 }]);
    const q = log.raw.find((x) => /kdpv_folio_caja/.test(x.sql))!;
    expect(q.params[3]).toEqual(catalogo.map((c) => c.code));
    // [negativa] ya no depende de un alta: la consulta no lee mkt_ranking_promos.
    expect(q.sql).not.toMatch(/mkt_ranking_promos/);
  });

  it('[negativa] sin promociones en el catálogo no consulta la venta y no trae tickets', async () => {
    const { trx, log } = fakeTrx({ catalogo: [], ventas: [ticket('A1', 'C01')] });
    const r = await vendSvc(trx).tickets('03', '7', 'C01', false);
    expect(r.tickets).toEqual([]);
    expect(log.raw.some((x) => /kdpv_folio_caja/.test(x.sql))).toBe(false);
  });
});
