import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * SM.6 — Queries de la consola del Supervisor de Movimientos. Expone la data
 * CRUDA (cortes de caja, movimientos de inventario) + un overview agregado, para
 * que la consola muestre "todo" y no solo los descuadres flagueados.
 * analytics.* sin RLS → filtro tenant_id EXPLÍCITO. Solo lectura.
 */
@Injectable()
export class ReconciliationQueryService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** KPIs + rankings para el tab Resumen. */
  async overview() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const caja: any = await trx('analytics.cash_cuts').where('tenant_id', tenantId)
        .select(
          trx.raw('COUNT(*)::int AS cortes'),
          trx.raw('COUNT(*) FILTER (WHERE abs(efectivo_diff) >= 50)::int AS con_descuadre'),
          trx.raw('ROUND(SUM(GREATEST(efectivo_diff, 0))::numeric, 2) AS faltante'),
          trx.raw('ROUND(SUM(-LEAST(efectivo_diff, 0))::numeric, 2) AS sobrante'),
          trx.raw('ROUND(SUM(total_venta)::numeric, 2) AS venta'),
        ).first();
      const merma: any = await trx('analytics.stock_ledger').where({ tenant_id: tenantId, clase_mov: 'merma' })
        .select(trx.raw('COUNT(*)::int AS movs'), trx.raw('ROUND(SUM(importe)::numeric, 2) AS monto')).first();
      const disc: any = await trx('reconciliation.discrepancies')
        .where('tenant_id', trx.raw('public.current_tenant_id()')).whereIn('status', ['nuevo', 'en_revision'])
        .select(trx.raw('COUNT(*)::int AS pendientes'), trx.raw("COUNT(*) FILTER (WHERE severity='critical')::int AS criticos")).first();

      const topCajeros = await trx('analytics.cash_cuts').where('tenant_id', tenantId)
        .whereRaw('efectivo_diff >= 50').whereNotNull('cajero_cierre')
        .groupBy('warehouse_code', 'cajero_cierre')
        .select('warehouse_code', 'cajero_cierre',
          trx.raw('COUNT(*)::int AS eventos'),
          trx.raw('ROUND(SUM(efectivo_diff)::numeric, 2) AS faltante'))
        .orderByRaw('SUM(efectivo_diff) DESC').limit(10);

      const porSucursal = await trx('analytics.cash_cuts').where('tenant_id', tenantId)
        .groupBy('warehouse_code')
        .select('warehouse_code',
          trx.raw('COUNT(*)::int AS cortes'),
          trx.raw('ROUND(SUM(GREATEST(efectivo_diff, 0))::numeric, 2) AS faltante'))
        .orderByRaw('SUM(GREATEST(efectivo_diff, 0)) DESC');
      const mermaSuc = await trx('analytics.stock_ledger').where({ tenant_id: tenantId, clase_mov: 'merma' })
        .groupBy('warehouse_code')
        .select('warehouse_code', trx.raw('ROUND(SUM(importe)::numeric, 2) AS merma'))
        .orderByRaw('SUM(importe) DESC');
      const mermaMap = Object.fromEntries(mermaSuc.map((r: any) => [r.warehouse_code, Number(r.merma)]));

      return {
        caja: {
          cortes: Number(caja?.cortes || 0), con_descuadre: Number(caja?.con_descuadre || 0),
          faltante: Number(caja?.faltante || 0), sobrante: Number(caja?.sobrante || 0), venta: Number(caja?.venta || 0),
        },
        inventario: { mermas: Number(merma?.movs || 0), monto_merma: Number(merma?.monto || 0) },
        descuadres: { pendientes: Number(disc?.pendientes || 0), criticos: Number(disc?.criticos || 0) },
        top_cajeros: topCajeros.map((r: any) => ({ sucursal: r.warehouse_code, cajero: r.cajero_cierre, eventos: Number(r.eventos), faltante: Number(r.faltante) })),
        por_sucursal: porSucursal.map((r: any) => ({ sucursal: r.warehouse_code, cortes: Number(r.cortes), faltante_caja: Number(r.faltante), merma: mermaMap[r.warehouse_code] || 0 })),
      };
    });
  }

  /** Cortes de caja (data cruda) — tab Cortes. */
  async cashCuts(q: { sucursal?: string; cajero?: string; from?: string; to?: string; min_diff?: number; solo_descuadres?: boolean; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.cash_cuts').where('tenant_id', tenantId)
        .select('id', 'warehouse_code', 'warehouse_name', 'caja', 'folio', 'business_date',
          'cajero_cierre', 'turno',
          trx.raw('efectivo_esperado::numeric AS efectivo_esperado'), trx.raw('efectivo_contado::numeric AS efectivo_contado'),
          trx.raw('efectivo_diff::numeric AS efectivo_diff'), trx.raw('tarjeta_esperado::numeric AS tarjeta_esperado'),
          trx.raw('transfer_esperado::numeric AS transfer_esperado'), trx.raw('total_venta::numeric AS total_venta'))
        .orderBy('business_date', 'desc').orderByRaw('abs(efectivo_diff) DESC').limit(limit);
      if (q.sucursal) b.where('warehouse_code', q.sucursal);
      if (q.cajero) b.whereRaw('cajero_cierre ILIKE ?', [`%${q.cajero}%`]);
      if (q.from) b.where('business_date', '>=', q.from);
      if (q.to) b.where('business_date', '<=', q.to);
      if (q.solo_descuadres) b.whereRaw('abs(efectivo_diff) >= ?', [Number(q.min_diff) || 50]);
      else if (q.min_diff) b.whereRaw('abs(efectivo_diff) >= ?', [Number(q.min_diff)]);
      const rows = await b;
      return rows.map((r: any) => ({
        ...r,
        efectivo_esperado: Number(r.efectivo_esperado), efectivo_contado: Number(r.efectivo_contado),
        efectivo_diff: Number(r.efectivo_diff), tarjeta_esperado: Number(r.tarjeta_esperado),
        transfer_esperado: Number(r.transfer_esperado), total_venta: Number(r.total_venta),
      }));
    });
  }

  /** Movimientos de inventario (data cruda) — tab Movimientos. */
  async movements(q: { clase_mov?: string; sucursal?: string; sku?: string; from?: string; to?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.stock_ledger').where('tenant_id', tenantId)
        .select('id', 'warehouse_code', 'almacen', 'sku', 'clase_mov', 'grupo', 'folio', 'unidad',
          trx.raw('unidades::numeric AS unidades'), trx.raw('importe::numeric AS importe'), 'fecha')
        .orderBy('fecha', 'desc').orderByRaw('importe DESC').limit(limit);
      if (q.clase_mov) b.where('clase_mov', q.clase_mov);
      if (q.sucursal) b.where('warehouse_code', q.sucursal);
      if (q.sku) b.whereRaw('sku ILIKE ?', [`%${q.sku}%`]);
      if (q.from) b.where('fecha', '>=', q.from);
      if (q.to) b.where('fecha', '<=', q.to);
      const rows = await b;
      return rows.map((r: any) => ({ ...r, unidades: Number(r.unidades), importe: Number(r.importe) }));
    });
  }
}
