import { ProductFlowService } from './product-flow.service';

/**
 * `[PF.8]` Los márgenes del panel salen de la matvista nocturna si está poblada y llega hasta ayer; si no, de la
 * función de Productos nuevos con el MISMO periodo, y la respuesta lo declara.
 */
const HOY = '2026-10-12';
const FILAS = [
  { tipo: 'venta', plaza: '01', factor: '1.0000', unidad_base: 'PZA', n: '100', nc: '100', c: '70', q: '20' },
  { tipo: 'entrada', plaza: '01', factor: '12.0000', unidad_base: 'PZA', n: '240', nc: '0', c: '0', q: '60' },
];

function montar(estado: { poblada: boolean; hasta?: string; desde?: string }) {
  const sqls: string[] = [];
  const trx = {
    raw: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('FROM catalog.products')) return { rows: [{ id: 'p-1', sku: '70001' }] };
      if (sql.includes('mv_kepler_sales_daily k')) return { rows: [{ hoy: HOY, corte: HOY }] };
      if (sql.includes('relispopulated')) return { rows: [{ poblada: estado.poblada }] };
      if (sql.includes('max(hasta)')) return { rows: [{ hasta: estado.hasta, desde: estado.desde, calculado_at: new Date('2026-10-12T12:20:00Z') }] };
      if (sql.includes('FROM analytics.mv_product_margins_30d')) {
        if (!estado.poblada) throw new Error('materialized view has not been populated');
        return { rows: FILAS };
      }
      if (sql.includes('fn_new_products_movimientos')) return { rows: FILAS };
      if (sql.includes('v_kepler_margin_target')) return { rows: [{ plaza: '01', factor: '1.0000', margen: '20' }] };
      if (sql.includes('commercial.warehouses')) return { rows: [{ plaza: '01', name: 'Padre Hidalgo' }] };
      return { rows: [] };
    },
  };
  const tk = { run: async (cb: (t: unknown) => unknown) => cb(trx) };
  const svc = new ProductFlowService(tk as never, { requireTenantId: () => 't' } as never, {} as never);
  return { svc, sqls };
}

const UUID = '00000000-0000-0000-0000-000000000001';

describe('[PF.8] márgenes del panel: matvista nocturna o en vivo', () => {
  it('⭐ poblada y al día (hasta ayer): sale de la matvista, sin tocar la función', async () => {
    const { svc, sqls } = montar({ poblada: true, hasta: '2026-10-11', desde: '2026-09-12' });
    const m = await svc.margins(UUID);
    expect(m.origen).toEqual({ fuente: 'foto', calculado_at: '2026-10-12T12:20:00.000Z' });
    expect(sqls.some((s) => s.includes('fn_new_products_movimientos'))).toBe(false);
    expect(m).toMatchObject({ desde: '2026-09-12', hasta: '2026-10-11' });
    expect(m.total?.real.pct).toBe(30);
  });

  it('⛔ sin poblar: en vivo, y NO intenta leerla (truena con 55000 y abortaría la transacción)', async () => {
    const { svc, sqls } = montar({ poblada: false });
    const m = await svc.margins(UUID);
    expect(m.origen.fuente).toBe('en_vivo');
    expect(sqls.some((s) => s.includes('FROM analytics.mv_product_margins_30d'))).toBe(false);
  });

  it('⛔ si no llega hasta ayer (el nocturno no corrió): en vivo con el mismo periodo', async () => {
    const { svc, sqls } = montar({ poblada: true, hasta: '2026-10-10', desde: '2026-09-11' });
    const m = await svc.margins(UUID);
    expect(m.origen.fuente).toBe('en_vivo');
    expect(sqls.some((s) => s.includes('fn_new_products_movimientos'))).toBe(true);
    expect(m).toMatchObject({ desde: '2026-09-12', hasta: '2026-10-11' });
  });

  it('las dos fuentes con las mismas filas dan los mismos márgenes', async () => {
    const foto = await montar({ poblada: true, hasta: '2026-10-11', desde: '2026-09-12' }).svc.margins(UUID);
    const vivo = await montar({ poblada: false }).svc.margins(UUID);
    expect(foto.total).toEqual(vivo.total);
    expect(foto.plazas).toEqual(vivo.plazas);
  });
});
