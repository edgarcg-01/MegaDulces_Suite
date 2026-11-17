import { MktRankingService } from './mkt-ranking.service';
import type { ProductosDePromo } from './mkt-ranking.logic';

/**
 * `[MKT.27]` El detalle de un participante se busca con la pistola: el ranking manda los códigos
 * de barras de los productos que activan cada promo (`sku → códigos`), una sola vez por respuesta.
 * La base se simula: cada consulta se reconoce por la tabla que lee. Se prueban las reglas, no el SQL.
 */

interface Fake {
  catalogo: Array<{ code: string; nombre: string | null }>;
  semana: Array<Record<string, unknown>>;
  barras?: Array<{ sku: string; codigos: string[] }>;
  /** Simula que la lectura de catalog.product_barcodes truena (permiso, tabla, red). */
  barrasTruena?: boolean;
}

function fakeTrx(f: Fake) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const raw = (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/catalog\.product_barcodes/.test(sql)) {
      if (f.barrasTruena) return Promise.reject(new Error('permission denied for table product_barcodes'));
      const skus = params[0] as string[];
      return Promise.resolve({ rows: (f.barras ?? []).filter((x) => skus.includes(x.sku)) });
    }
    if (/FROM catalog\.products/.test(sql) && /GROUP BY 1/.test(sql)) return Promise.resolve({ rows: f.catalogo });
    if (/v_kepler_sales_lines/.test(sql) && /min\(business_date\)/.test(sql)) {
      const canales = params[params.length - 1] as string[];
      return Promise.resolve({ rows: f.semana.filter((r) => canales.includes(String(r['canal']))) });
    }
    return Promise.resolve({ rows: [] });
  };
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['whereNull', 'whereNotNull', 'select', 'orderBy', 'whereBetween', 'whereIn', 'where']) b[m] = () => b;
    b['first'] = () => Promise.resolve(undefined);
    b['then'] = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve([]).then(ok, ko);
    return b;
  };
  const trx = Object.assign(() => builder(), { raw, fn: { now: () => 'now()' } });
  return { trx, consultas };
}

/** El servicio con el producto de cada promo ya identificado (se salta la deducción por tickets). */
function svcCon(trx: unknown, ident: Record<string, ProductosDePromo>) {
  const svc = new MktRankingService(
    { run: (fn: (t: unknown) => unknown) => fn(trx) } as never,
    { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).productosConCache = () => Promise.resolve(new Map(Object.entries(ident)));
  return svc;
}

const catalogo = [{ code: '09003', nombre: '5 EXH CANELS = GRATIS 1' }, { code: '09061', nombre: '2 EXH EFFEM = GRATIS 1' }];
const semana = [
  { canal: 'mostrador', sku: '09003', warehouse_code: '03', primera: new Date('2026-11-10T00:00:00Z') },
  { canal: 'mostrador', sku: '09061', warehouse_code: '03', primera: new Date('2026-11-10T00:00:00Z') },
];
const identificado = (sku: string, nombre: string): ProductosDePromo =>
  ({ metodo: 'ticket_y_nombre', tickets: 12, productos: [{ sku, nombre, tickets: 12, pct: 90 }], nota: '' });

describe('[MKT.27] los códigos de barras viajan con el ranking', () => {
  it('⭐ cada producto identificado trae sus códigos (principal y secundarios); se piden sólo esos SKU', async () => {
    const { trx, consultas } = fakeTrx({
      catalogo, semana,
      barras: [{ sku: '20005', codigos: ['7501000120056', '750100012005'] }, { sku: '99999', codigos: ['0000000000000'] }],
    });
    const r = await svcCon(trx, { '09003': identificado('20005', 'CANELS 4S SURTIDO DISPLAY 60P') }).ranking('2026-11-09', 'mostrador');
    expect(r.codigos_barras).toEqual({ '20005': ['7501000120056', '750100012005'] });
    const q = consultas.find((c) => /catalog\.product_barcodes/.test(c.sql));
    expect(q?.params[0]).toEqual(['20005']);
    expect(q?.sql).toMatch(/deleted_at IS NULL/);
    // los renglones NO repiten los códigos: viajan una sola vez
    expect(JSON.stringify(r.participantes)).not.toContain('7501000120056');
  });

  it('[negativa] si la lectura de códigos truena, el ranking sale igual y codigos_barras es null (no medido), no {}', async () => {
    const { trx } = fakeTrx({ catalogo, semana, barrasTruena: true });
    const r = await svcCon(trx, { '09003': identificado('20005', 'CANELS') }).ranking('2026-11-09', 'mostrador');
    expect(r.codigos_barras).toBeNull();
    expect(r.participantes.length).toBeGreaterThan(0);
    expect(r.participantes[0].promos.map((x) => x.code).sort()).toEqual(['09003', '09061']);
  });

  it('[control] sin productos identificados no consulta la tabla y manda {} (no hay nada que buscar)', async () => {
    const { trx, consultas } = fakeTrx({ catalogo, semana, barras: [{ sku: '20005', codigos: ['7501000120056'] }] });
    const r = await svcCon(trx, {}).ranking('2026-11-09', 'mostrador');
    expect(r.codigos_barras).toEqual({});
    expect(consultas.some((c) => /catalog\.product_barcodes/.test(c.sql))).toBe(false);
  });
});
