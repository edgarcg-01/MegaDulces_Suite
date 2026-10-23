import { zoneStock } from './zone-stock';

/**
 * `[MCP.3.12]` La tira de existencias de la zona. Lo que importa:
 *  (1) sólo sucursales centrales activas de la MISMA zona (el CEDIS, «Corporativo», nunca);
 *  (2) la del vendedor primero, luego el orden del catálogo;
 *  (3) «sin renglón» es `null` (sin dato), distinto de 0;
 *  (4) un producto sin existencia en ninguna sucursal no viaja;
 *  (5) sin sucursal / sin zona se DECLARA, nunca se devuelve como ceros.
 */
const LPA = 'w-02', PH = 'w-01', ES8 = 'w-03', YU = 'w-04', CAN = 'w-06', CEDIS = 'w-00', BAJA = 'w-09';

interface Wh { id: string; kepler_code: string; short_label: string | null; name: string; purchase_zone: string | null; kind: string; active: boolean; deleted_at: string | null; display_order: number | null }
const WHS: Wh[] = [
  { id: CEDIS, kepler_code: '00', short_label: 'CEDIS', name: 'CEDIS', purchase_zone: 'Corporativo', kind: 'central', active: true, deleted_at: null, display_order: 9 },
  { id: PH, kepler_code: '01', short_label: 'PH', name: 'Padre Hidalgo', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 1 },
  { id: LPA, kepler_code: '02', short_label: 'LPA', name: 'La Piedad Abastos', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 5 },
  { id: ES8, kepler_code: '03', short_label: '8ES', name: '8 Esquinas', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 4 },
  { id: YU, kepler_code: '04', short_label: null, name: 'Yurécuaro', purchase_zone: 'La Piedad', kind: 'central', active: true, deleted_at: null, display_order: 6 },
  { id: CAN, kepler_code: '06', short_label: 'CAN', name: 'Canindo', purchase_zone: 'Zamora', kind: 'central', active: true, deleted_at: null, display_order: 7 },
  { id: BAJA, kepler_code: '09', short_label: 'X', name: 'Inactiva', purchase_zone: 'La Piedad', kind: 'central', active: false, deleted_at: null, display_order: 2 },
];

interface Stock { product_id: string; warehouse_id: string; quantity: number; reserved_quantity: number | null; updated_at: string }

function fakeTrx(whs: Wh[], stock: Stock[]) {
  const raws: string[] = [];
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
  const trx: any = Object.assign(tabla, {
    raw: async (sql: string, b: unknown[]) => {
      raws.push(sql);
      const ids = b[0] as string[];
      const mios = stock.filter((s) => ids.includes(s.warehouse_id));
      if (sql.includes('max(s.updated_at)')) {
        const m = new Map<string, string>();
        for (const s of mios) if (!m.has(s.warehouse_id) || s.updated_at > m.get(s.warehouse_id)!) m.set(s.warehouse_id, s.updated_at);
        return { rows: [...m].map(([warehouse_id, as_of]) => ({ warehouse_id, as_of })) };
      }
      return { rows: mios.map((s) => ({ product_id: s.product_id, warehouse_id: s.warehouse_id, q: String(Math.max(s.quantity - (s.reserved_quantity ?? 0), 0)) })) };
    },
  });
  return { trx, raws };
}

const st = (product_id: string, warehouse_id: string, quantity: number, reserved: number | null = 0): Stock =>
  ({ product_id, warehouse_id, quantity, reserved_quantity: reserved, updated_at: '2026-10-23T19:05:00Z' });

describe('zoneStock · [MCP.3.12]', () => {
  it('⭐ La Piedad: su sucursal primero, el CEDIS, Canindo y la inactiva fuera; nombre corto o clave', async () => {
    const { trx } = fakeTrx(WHS, [st('pul', PH, 14), st('pul', CEDIS, 500), st('pul', CAN, 9)]);
    const r = await zoneStock(trx, LPA);
    expect(r.zone).toBe('La Piedad');
    expect(r.unmeasured_reason).toBeNull();
    expect(r.warehouses.map((w) => w.short)).toEqual(['LPA', 'PH', '8ES', '04']);
    expect(r.warehouses.map((w) => w.mine)).toEqual([true, false, false, false]);
    expect(r.warehouses[1].as_of).toBe('2026-10-23T19:05:00.000Z');
    expect(r.warehouses[2].as_of).toBeNull();
  });

  it('⭐ disponible = cantidad − apartado; sin renglón = null (sin dato), distinto de 0', async () => {
    const { trx } = fakeTrx(WHS, [st('pul', LPA, 0), st('pul', PH, 20, 6), st('pul', YU, 2, null)]);
    const r = await zoneStock(trx, LPA);
    expect(r.stock['pul']).toEqual([0, 14, null, 2]);
  });

  it('un apartado mayor que la cantidad no da negativo', async () => {
    const { trx } = fakeTrx(WHS, [st('a', LPA, 3, 5), st('a', PH, 1)]);
    expect((await zoneStock(trx, LPA)).stock['a']).toEqual([0, 1, null, null]);
  });

  it('un producto sin existencia en NINGUNA sucursal de la zona no viaja', async () => {
    const { trx } = fakeTrx(WHS, [st('vacio', LPA, 0), st('vacio', PH, 4, 4), st('lleno', ES8, 1)]);
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
    const { trx, raws } = fakeTrx(sinZona, [st('pul', PH, 14)]);
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
    const { trx } = fakeTrx(WHS, [st('pul', PH, 14), st('pul', CAN, 3)]);
    const r = await zoneStock(trx, CAN);
    expect(r.zone).toBe('Zamora');
    expect(r.warehouses.map((w) => w.short)).toEqual(['CAN']);
    expect(r.stock['pul']).toEqual([3]);
  });
});
