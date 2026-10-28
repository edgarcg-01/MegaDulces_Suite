import { zoneStock } from './zone-stock';

/**
 * `[MCP.3.12]` La tira de existencias de la zona. Lo que importa:
 *  (1) sólo sucursales centrales activas de la MISMA zona (el CEDIS, «Corporativo», nunca);
 *  (2) la del vendedor primero, luego el orden del catálogo;
 *  (3) «sin renglón» es `null`, distinto de 0;
 *  (4) un producto sin existencia en ninguna sucursal no viaja;
 *  (5) sin sucursal / sin zona se DECLARA, nunca se devuelve como ceros.
 *
 * `[MCP.3.16]` Y desde la vista canónica, con frescura por sucursal:
 *  (6) la sucursal con lectura vieja / con error / sin fila viaja `stale` y sus celdas en `null`;
 *  (7) el duplicado legado trae la existencia de su gemelo;
 *  (8) si la lectura de frescura falla (SAVEPOINT), todas son `stale`, nada se rompe;
 *  (9) si la existencia no se pudo leer, se DECLARA (no se devuelven ceros).
 */
const LPA = 'w-02', PH = 'w-01', ES8 = 'w-03', YU = 'w-04', CAN = 'w-06', CEDIS = 'w-00', BAJA = 'w-09';

interface Wh { id: string; code: string; kepler_code: string; short_label: string | null; name: string; purchase_zone: string | null; kind: string; active: boolean; deleted_at: string | null; display_order: number | null }
const WHS: Wh[] = [
  { id: CEDIS, code: '00', kepler_code: '00', short_label: 'CEDIS', name: 'CEDIS', purchase_zone: 'Corporativo', kind: 'central', active: true, deleted_at: null, display_order: 9 },
  { id: PH, code: '01', kepler_code: '01', short_label: 'PH', name: 'Padre Hidalgo', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 1 },
  { id: LPA, code: '02', kepler_code: '02', short_label: 'LPA', name: 'La Piedad Abastos', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 5 },
  { id: ES8, code: '03', kepler_code: '03', short_label: '8ES', name: '8 Esquinas', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 4 },
  { id: YU, code: '04', kepler_code: '04', short_label: null, name: 'Yurécuaro', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 6 },
  { id: CAN, code: '06', kepler_code: '06', short_label: 'CAN', name: 'Canindo', purchase_zone: 'Zamora', kind: 'central', active: true, deleted_at: null, display_order: 7 },
  { id: BAJA, code: '09', kepler_code: '09', short_label: 'X', name: 'Inactiva', purchase_zone: 'La Piedad', kind: 'central', active: false, deleted_at: null, display_order: 2 },
];

/** Una fila de la vista canónica (ya sumada por sucursal × producto). */
interface Ex { product_id: string; warehouse_id: string; qty: number }
/** Una fila de `ods_branch_checks` (`al_dia` ya evaluado como lo haría la base). */
interface Chk { sucursal: string; last_check_at: string; al_dia: boolean; last_error: string | null }

const AL_DIA = '2026-10-27T19:05:00Z';
const fresco = (codes: string[]): Chk[] => codes.map((sucursal) => ({ sucursal, last_check_at: AL_DIA, al_dia: true, last_error: null }));

function fakeTrx(whs: Wh[], ex: Ex[], opts: { checks?: Chk[]; checksFalla?: boolean; existenciaFalla?: boolean; gemelos?: Array<{ id: string; twin_id: string }> } = {}) {
  const raws: string[] = [];
  const checks = opts.checks ?? fresco(['00', '01', '02', '03', '04', '06']);
  const tabla = (nombre: string) => {
    const filtros: Record<string, unknown>[] = [];
    let primero: string | null = null;
    const q: any = {};
    q.where = (o: Record<string, unknown>) => { filtros.push(o); return q; };
    q.whereNull = () => q;
    q.select = () => q;
    q.orderByRaw = (_s: string, b: string[]) => { primero = b[0]; return q; };
    const data = () => {
      if (nombre !== 'commercial.warehouses') return [];
      let r = whs.filter((w) => !w.deleted_at && filtros.every((f) => Object.entries(f).every(([k, v]) => (w as any)[k] === v)));
      if (primero) {
        r = [...r].sort((a, b) => Number(b.id === primero) - Number(a.id === primero)
          || (a.display_order ?? 99) - (b.display_order ?? 99) || a.kepler_code.localeCompare(b.kepler_code));
      }
      return r;
    };
    q.first = async () => data()[0];
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(data()).then(ok, ko);
    return q;
  };
  const raw = async (sql: string, b: unknown[] = []) => {
    raws.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ ok: true }] };
    if (sql.includes('analytics.ods_branch_checks')) {
      if (opts.checksFalla) throw new Error('relation "analytics.ods_branch_checks" does not exist');
      const codes = b[2] as string[];
      return { rows: checks.filter((c) => codes.includes(c.sucursal)) };
    }
    if (sql.includes('analytics.v_erp_stock_on_hand')) {
      if (opts.existenciaFalla) throw new Error('canceling statement due to statement timeout');
      const ids = b[0] as string[];
      return { rows: ex.filter((e) => ids.includes(e.warehouse_id)) };
    }
    if (sql.includes('catalog.products')) return { rows: (opts.gemelos ?? []).map((g) => ({ id: g.id, con_sku: false, twin_id: g.twin_id })) };
    return { rows: [] };
  };
  const trx: any = Object.assign(tabla, { raw, transaction: async (cb: (sp: unknown) => unknown) => cb({ raw }) });
  return { trx, raws };
}

const e = (product_id: string, warehouse_id: string, qty: number): Ex => ({ product_id, warehouse_id, qty });

describe('zoneStock · [MCP.3.12]', () => {
  it('⭐ La Piedad: su sucursal primero, el CEDIS, Canindo y la inactiva fuera; nombre corto o clave', async () => {
    const { trx } = fakeTrx(WHS, [e('pul', PH, 14), e('pul', CEDIS, 500), e('pul', CAN, 9)]);
    const r = await zoneStock(trx, LPA);
    expect(r.zone).toBe('La Piedad');
    expect(r.unmeasured_reason).toBeNull();
    expect(r.warehouses.map((w) => w.short)).toEqual(['LPA', 'PH', '8ES', '04']);
    expect(r.warehouses.map((w) => w.mine)).toEqual([true, false, false, false]);
    expect(r.warehouses[1].as_of).toBe('2026-10-27T19:05:00.000Z');
    expect(r.warehouses[1].checked_at).toBe(r.warehouses[1].as_of);
  });

  it('⭐ sin renglón = null, distinto de 0 (0 = agotado)', async () => {
    const { trx } = fakeTrx(WHS, [e('pul', LPA, 0), e('pul', PH, 14), e('pul', YU, 2)]);
    const r = await zoneStock(trx, LPA);
    expect(r.stock['pul']).toEqual([0, 14, null, 2]);
  });

  it('un producto sin existencia en NINGUNA sucursal de la zona no viaja', async () => {
    const { trx } = fakeTrx(WHS, [e('vacio', LPA, 0), e('vacio', PH, 0), e('lleno', ES8, 1)]);
    const r = await zoneStock(trx, LPA);
    expect(Object.keys(r.stock)).toEqual(['lleno']);
  });

  it('⛔ sin sucursal: se declara, sin consultar existencias', async () => {
    const { trx, raws } = fakeTrx(WHS, []);
    const r = await zoneStock(trx, null);
    expect(r).toEqual({ zone: null, warehouses: [], stock: {}, unmeasured_reason: 'No tienes sucursal de surtido asignada.' });
    expect(raws).toEqual([]);
  });

  it('⛔ sucursal sin zona declarada: se dice por qué, no se inventa', async () => {
    const sinZona = WHS.map((w) => (w.id === LPA ? { ...w, purchase_zone: null } : w));
    const { trx, raws } = fakeTrx(sinZona, [e('pul', PH, 14)]);
    const r = await zoneStock(trx, LPA);
    expect(r.warehouses).toEqual([]);
    expect(r.unmeasured_reason).toMatch(/no tiene zona/);
    expect(raws).toEqual([]);
  });

  it('⛔ sucursal que no existe o está de baja', async () => {
    const { trx } = fakeTrx(WHS, []);
    const r = await zoneStock(trx, 'w-nada');
    expect(r.unmeasured_reason).toMatch(/no existe/);
  });

  it('Zamora sólo ve Zamora', async () => {
    const { trx } = fakeTrx(WHS, [e('pul', PH, 14), e('pul', CAN, 3)]);
    const r = await zoneStock(trx, CAN);
    expect(r.zone).toBe('Zamora');
    expect(r.warehouses.map((w) => w.short)).toEqual(['CAN']);
    expect(r.stock['pul']).toEqual([3]);
  });
});

describe('zoneStock · [MCP.3.16] vista canónica, frescura y gemelos', () => {
  it('⭐ lee la vista canónica, NO commercial.stock', async () => {
    const { trx, raws } = fakeTrx(WHS, [e('pul', LPA, 3)]);
    await zoneStock(trx, LPA);
    expect(raws.some((s) => s.includes('analytics.v_erp_stock_on_hand'))).toBe(true);
    expect(raws.some((s) => s.includes('commercial.stock'))).toBe(false);
  });

  it('⭐ sucursal con lectura vieja, con error o sin fila: stale y sus celdas null (nunca 0)', async () => {
    const checks: Chk[] = [
      { sucursal: '02', last_check_at: AL_DIA, al_dia: true, last_error: null },
      { sucursal: '01', last_check_at: '2026-10-26T01:00:00Z', al_dia: false, last_error: null },
      { sucursal: '03', last_check_at: AL_DIA, al_dia: false, last_error: 'ECONNRESET' },
      // 04 sin fila
    ];
    const { trx } = fakeTrx(WHS, [e('pul', LPA, 2), e('pul', PH, 99), e('pul', ES8, 7), e('pul', YU, 5)], { checks });
    const r = await zoneStock(trx, LPA);
    expect(r.warehouses.map((w) => w.stale)).toEqual([false, true, true, true]);
    expect(r.warehouses.map((w) => w.checked_at)).toEqual([
      '2026-10-27T19:05:00.000Z', '2026-10-26T01:00:00.000Z', '2026-10-27T19:05:00.000Z', null,
    ]);
    // Lo de las stale NO se publica aunque la vista tenga número.
    expect(r.stock['pul']).toEqual([2, null, null, null]);
  });

  it('negativa: un producto con existencia SÓLO en sucursales stale no viaja como «hay»', async () => {
    const checks = fresco(['02']);
    const { trx } = fakeTrx(WHS, [e('pul', PH, 99)], { checks });
    const r = await zoneStock(trx, LPA);
    expect(r.stock['pul']).toBeUndefined();
  });

  it('⛔ la lectura de frescura falla (SAVEPOINT): todas stale, sin romper y sin ceros', async () => {
    const { trx } = fakeTrx(WHS, [e('pul', LPA, 2)], { checksFalla: true });
    const r = await zoneStock(trx, LPA);
    expect(r.unmeasured_reason).toBeNull();
    expect(r.warehouses.every((w) => w.stale)).toBe(true);
    expect(r.stock).toEqual({});
  });

  it('⛔ la existencia no se pudo leer: se declara, no se devuelve una zona vacía como ceros', async () => {
    const { trx } = fakeTrx(WHS, [e('pul', LPA, 2)], { existenciaFalla: true });
    const r = await zoneStock(trx, LPA);
    expect(r.warehouses).toEqual([]);
    expect(r.unmeasured_reason).toMatch(/No se pudo leer la existencia/);
  });

  it('⭐ el duplicado legado trae la existencia de su gemelo, bajo su propio id', async () => {
    const { trx } = fakeTrx(WHS, [e('vivo', LPA, 0), e('vivo', PH, 14)], { gemelos: [{ id: 'legado', twin_id: 'vivo' }] });
    const r = await zoneStock(trx, LPA);
    expect(r.stock['vivo']).toEqual([0, 14, null, null]);
    expect(r.stock['legado']).toEqual([0, 14, null, null]);
  });

  it('negativa: sin gemelo el legado no viaja (no se inventa existencia)', async () => {
    const { trx } = fakeTrx(WHS, [e('vivo', PH, 14)], { gemelos: [] });
    const r = await zoneStock(trx, LPA);
    expect(r.stock['legado']).toBeUndefined();
  });
});
