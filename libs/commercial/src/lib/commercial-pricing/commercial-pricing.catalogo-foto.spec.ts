import { CommercialPricingService } from './commercial-pricing.service';

/**
 * `[VTK.10]` El catálogo del vendedor ya no recalcula en cada apertura las dos piezas que
 * costaban ~11 s en prod: el mayoreo de toda la red y la escalera de la sucursal.
 *
 * La base es un doble que ANOTA cada tabla que se consulta, así que la prueba mide lo que sale
 * a la base en cada apertura (no si la función "parece" usar caché).
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const LISTA = '00000000-0000-0000-0000-0000c0ffee02';
const ALMACEN = '164234e8-074e-4111-b47e-1d4da0502b1c';

function filas(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `pp${i}`, product_id: `p${i}`, sku: String(1000 + i), price: 5 }));
}

function montar(nFilas: number) {
  const tablas: string[] = [];
  const productos = filas(nFilas);
  function builder(tabla: string) {
    let esConteo = false;
    const valor = () => {
      if (tabla.startsWith('catalog.products')) return esConteo ? [{ total: String(nFilas) }] : productos;
      if (tabla === 'analytics.product_volume_tiers') return [{ product_id: 'p0', min_qty: 3, price: 4.5 }];
      return [];
    };
    const b: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'whereNull', 'where', 'whereNotNull', 'whereRaw', 'whereIn', 'select', 'orderByRaw', 'orderBy', 'limit', 'offset']) {
      b[m] = () => b;
    }
    b['count'] = () => { esConteo = true; return b; };
    b['first'] = () => Promise.resolve(tabla === 'commercial.warehouses' ? { kepler_code: '02' } : undefined);
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(valor()).then(ok, ko);
    return b;
  }
  const trx = Object.assign(
    (tabla: string) => { tablas.push(tabla); return builder(tabla); },
    { raw: () => ({ then: (ok: (v: unknown) => unknown) => Promise.resolve({ rows: [{ t: true }] }).then(ok) }) },
  );
  const tk = {
    run: (a: unknown, b?: unknown) => {
      const cb = (typeof a === 'string' ? b : a) as (t: unknown) => Promise<unknown>;
      return cb(trx);
    },
  };
  const tenantCtx = { requireTenantId: () => TENANT, get: () => ({ roleName: 'vendedor', tenantId: TENANT }) };
  const escalera = {
    rungs: {
      base: { rung: 'base', label: 'PZA', size: 1, price: 5, volume: null },
      pack: null,
      box: { rung: 'box', label: 'CJA', size: 12, price: 55, volume: null },
    },
  };
  const quotePricing = {
    ladders: vi.fn(async () => new Map(productos.map((p) => [p.sku, escalera]))),
  };
  const svc = new CommercialPricingService(tk as never, tenantCtx as never, quotePricing as never);
  const abrir = () =>
    svc.listPrices(LISTA, { warehouseId: ALMACEN, pricedOnly: true, commercialOnly: true, sort: 'sales', pageSize: 10000 }) as Promise<{
      data: Array<{ tiers?: unknown[]; rungs?: unknown[] }>;
      freshness: { tiers_at: string | null; ladders_at: string | null };
    }>;
  return { abrir, tablas, quotePricing };
}

describe('catálogo del vendedor · las piezas caras se sirven de foto', () => {
  it('⭐ dos aperturas seguidas leen el mayoreo y la escalera UNA sola vez', async () => {
    const { abrir, tablas, quotePricing } = montar(600);
    const a = await abrir();
    const b = await abrir();
    // Prueba negativa: el código anterior consultaba la vista en CADA apertura (aquí serían 2).
    expect(tablas.filter((t) => t === 'analytics.product_volume_tiers')).toHaveLength(1);
    expect(quotePricing.ladders).toHaveBeenCalledTimes(1);
    expect(quotePricing.ladders).toHaveBeenCalledWith(expect.anything(), '02', null);
    // Y lo que se sirve es lo mismo que antes: mayoreo y escalera pegados a su fila.
    for (const r of [a, b]) {
      expect(r.data[0].tiers).toEqual([{ min_qty: 3, price: 4.5 }]);
      expect(r.data[1].tiers).toEqual([]);
      expect(r.data[0].rungs).toHaveLength(2);
    }
  });

  it('⭐ la edad de cada foto viaja en la respuesta (no se rotula como de este segundo)', async () => {
    const { abrir } = montar(600);
    const r = await abrir();
    expect(r.freshness.tiers_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.freshness.ladders_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('con pocas filas (búsqueda puntual) la escalera se lee en vivo, como antes', async () => {
    const { abrir, quotePricing } = montar(20);
    const r = await abrir();
    expect(quotePricing.ladders).toHaveBeenCalledWith(expect.anything(), '02', expect.arrayContaining(['1000', '1019']));
    expect(r.freshness.ladders_at).toBeNull();
  });

  it('las fotos son por servicio: el mayoreo no se pide por producto', async () => {
    const { abrir, tablas } = montar(600);
    await abrir();
    // Una sola lectura de la vista para todo el tenant, sin depender de qué productos trae la página.
    expect(tablas.filter((t) => t === 'analytics.product_volume_tiers')).toHaveLength(1);
    expect(tablas.filter((t) => t === 'analytics.product_units')).toHaveLength(1);
  });
});
