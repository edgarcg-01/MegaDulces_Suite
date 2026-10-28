import { CommercialPricingService } from './commercial-pricing.service';

/**
 * `[MCP.3.16]` El catálogo con `stock_state=1`. La base es un doble que ANOTA cada join, cada
 * columna cruda y el ORDER BY: la prueba mide el SQL que sale, no si el código «parece» cambiar.
 *
 *  (1) Sin `stock_state` todo queda EXACTAMENTE como antes (portal y `view` lo leen así).
 *  (2) Con `stock_state` pero sin almacén, también.
 *  (3) Con los dos: vista canónica + gemelo, NO `commercial.stock`, «no se maneja» al final y el
 *      estado de cada renglón con la regla única.
 *  (4) Lectura de la sucursal vieja: todo `sin_dato` y el orden pedido sin tocar.
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const LISTA = '00000000-0000-0000-0000-0000c0ffee02';
const ALMACEN = '164234e8-074e-4111-b47e-1d4da0502b1c';

interface Registro {
  tablas: string[];
  leftJoins: string[];
  joinRaws: Array<{ sql: string; bindings?: unknown[] }>;
  selects: string[];
  orderBy: string[];
}

function montar(opts: { filas: Array<Record<string, unknown>>; alDia?: boolean }) {
  const reg: Registro = { tablas: [], leftJoins: [], joinRaws: [], selects: [], orderBy: [] };
  const raw = (sql: string, bindings?: unknown[]) => {
    const r = { sql, bindings, toString: () => sql } as Record<string, unknown>;
    r['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let rows: unknown[] = [{ t: true, ok: true }];
      if (sql.includes('analytics.ods_branch_checks')) {
        rows = [{ sucursal: '02', last_check_at: '2026-10-27T19:00:00Z', last_error: null, al_dia: opts.alDia !== false }];
      }
      return Promise.resolve({ rows }).then(ok, ko);
    };
    return r;
  };
  function builder(tabla: string) {
    let esConteo = false;
    const b: Record<string, unknown> = {};
    for (const m of ['whereNull', 'where', 'whereNotNull', 'whereRaw', 'whereIn', 'orderBy', 'limit', 'offset']) b[m] = () => b;
    b['leftJoin'] = (t: string) => { reg.leftJoins.push(t); return b; };
    b['joinRaw'] = (sql: string, bindings?: unknown[]) => { reg.joinRaws.push({ sql, bindings }); return b; };
    b['select'] = (...cols: unknown[]) => {
      for (const c of cols) reg.selects.push(typeof c === 'string' ? c : String((c as { sql?: string }).sql ?? c));
      return b;
    };
    b['orderByRaw'] = (s: string) => { reg.orderBy.push(s); return b; };
    b['count'] = () => { esConteo = true; return b; };
    b['first'] = () => Promise.resolve(tabla === 'commercial.warehouses' ? { id: ALMACEN, code: '02', kepler_code: '02' } : undefined);
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const v = tabla.startsWith('catalog.products')
        ? (esConteo ? [{ total: String(opts.filas.length) }] : opts.filas.map((f) => ({ ...f })))
        : [];
      return Promise.resolve(v).then(ok, ko);
    };
    return b;
  }
  const trx = Object.assign(
    (tabla: string) => { reg.tablas.push(tabla); return builder(tabla); },
    { raw, transaction: async (cb: (sp: unknown) => unknown) => cb({ raw: (s: string, b?: unknown[]) => raw(s, b) }) },
  );
  const tk = { run: (a: unknown, b?: unknown) => ((typeof a === 'string' ? b : a) as (t: unknown) => Promise<unknown>)(trx) };
  const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ roleName: 'vendedor_ruta', tenantId: TENANT }) };
  const quotePricing = { ladders: vi.fn(async () => new Map()) };
  const svc = new CommercialPricingService(tk as never, tenantCtx as never, quotePricing as never);
  return { svc, reg };
}

type Fila = Record<string, unknown>;
const listar = (svc: CommercialPricingService, o: { warehouseId?: string; stockState?: boolean }) =>
  svc.listPrices(LISTA, { ...o, pricedOnly: true, commercialOnly: true, sort: 'sales', pageSize: 10000 }) as Promise<{ data: Fila[] }>;

const VIEJO_STOCK = 'CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available';

describe('[MCP.3.16] catálogo · sin stock_state todo igual que antes', () => {
  it('⭐ con almacén y SIN stock_state: commercial.stock, el mismo stock_available y el mismo orden', async () => {
    const { svc, reg } = montar({ filas: [{ product_id: 'a', sku: '1', stock_available: 4 }] });
    const r = await listar(svc, { warehouseId: ALMACEN });
    expect(reg.leftJoins).toContain('commercial.stock as s');
    expect(reg.joinRaws).toEqual([]);
    expect(reg.selects).toContain(VIEJO_STOCK);
    expect(reg.selects.some((s) => s.includes('stock_medible'))).toBe(false);
    expect(reg.orderBy).toEqual(['ts.sales_rank ASC NULLS LAST, p.nombre ASC']);
    expect(r.data[0]).not.toHaveProperty('stock_state');
    expect(r.data[0]['stock_available']).toBe(4);
    // Ni siquiera se pregunta la frescura.
    expect(reg.tablas.filter((t) => t === 'commercial.warehouses')).toHaveLength(1); // la de la escalera, como siempre
  });

  it('stock_state SIN almacén: igual que antes (no hay sucursal de la cual afirmar)', async () => {
    const { svc, reg } = montar({ filas: [{ product_id: 'a', sku: '1', stock_available: null }] });
    const r = await listar(svc, { stockState: true });
    expect(reg.leftJoins).not.toContain('commercial.stock as s');
    expect(reg.joinRaws).toEqual([]);
    expect(reg.selects).toContain('NULL::int AS stock_available');
    expect(reg.orderBy).toEqual(['ts.sales_rank ASC NULLS LAST, p.nombre ASC']);
    expect(r.data[0]).not.toHaveProperty('stock_state');
  });
});

describe('[MCP.3.16] catálogo · con stock_state=1', () => {
  const filas = [
    { product_id: 'hay', sku: '1', stock_medible: true, stock_con_registro: true, stock_qty: 14, stock_twin_product_id: null },
    { product_id: 'cero', sku: '2', stock_medible: true, stock_con_registro: true, stock_qty: 0, stock_twin_product_id: null },
    { product_id: 'legado', sku: null, stock_medible: true, stock_con_registro: true, stock_qty: 9, stock_twin_product_id: 'vivo' },
    { product_id: 'nomaneja', sku: '3', stock_medible: true, stock_con_registro: false, stock_qty: null, stock_twin_product_id: null },
  ];

  it('⭐ vista canónica + gemelo, NO commercial.stock; «no se maneja» al final antes del orden pedido', async () => {
    const { svc, reg } = montar({ filas });
    await listar(svc, { warehouseId: ALMACEN, stockState: true });
    expect(reg.leftJoins).not.toContain('commercial.stock as s');
    expect(reg.selects).not.toContain(VIEJO_STOCK);
    const joins = reg.joinRaws.map((j) => j.sql).join('\n');
    expect(joins).toMatch(/LEFT JOIN catalog\.products tw/);
    expect(joins).toMatch(/analytics\.v_erp_stock_on_hand/);
    expect(reg.joinRaws.find((j) => j.sql.includes('v_erp_stock_on_hand'))?.bindings).toEqual([ALMACEN]);
    expect(reg.orderBy).toHaveLength(1);
    expect(reg.orderBy[0]).toMatch(/^\(CASE WHEN .*ex\.product_id IS NULL THEN 1 ELSE 0 END\) ASC, ts\.sales_rank ASC NULLS LAST, p\.nombre ASC$/);
  });

  it('⭐ cada renglón trae su estado con la regla única; las columnas auxiliares no viajan', async () => {
    const { svc } = montar({ filas });
    const r = await listar(svc, { warehouseId: ALMACEN, stockState: true });
    const por = new Map(r.data.map((f) => [f['product_id'], f]));
    expect(por.get('hay')).toMatchObject({ stock_state: 'con_existencia', stock_available: 14, stock_checked_at: '2026-10-27T19:00:00.000Z' });
    expect(por.get('cero')).toMatchObject({ stock_state: 'agotado', stock_available: 0 });
    expect(por.get('legado')).toMatchObject({ stock_state: 'con_existencia', stock_available: 9, stock_twin_product_id: 'vivo' });
    expect(por.get('nomaneja')).toMatchObject({ stock_state: 'no_se_maneja', stock_available: null });
    for (const f of r.data) {
      expect(f).not.toHaveProperty('stock_medible');
      expect(f).not.toHaveProperty('stock_con_registro');
      expect(f).not.toHaveProperty('stock_qty');
    }
  });

  it('⛔ lectura de la sucursal vieja: todo sin_dato, ningún número viejo y el orden pedido intacto', async () => {
    const { svc, reg } = montar({ filas, alDia: false });
    const r = await listar(svc, { warehouseId: ALMACEN, stockState: true });
    expect(r.data.every((f) => f['stock_state'] === 'sin_dato' && f['stock_available'] === null)).toBe(true);
    expect(reg.orderBy[0]).toBe('ts.sales_rank ASC NULLS LAST, p.nombre ASC');
  });
});
