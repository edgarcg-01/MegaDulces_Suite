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
          trx.raw('COUNT(*) FILTER (WHERE abs(tarjeta_diff) >= 50 OR abs(transfer_diff) >= 50)::int AS descuadre_no_efectivo'),
          trx.raw('COUNT(*) FILTER (WHERE efectivo_diff = 0 AND efectivo_esperado >= 3000)::int AS cuadre_exacto'),
          trx.raw('COUNT(*) FILTER (WHERE efectivo_esperado >= 3000)::int AS cortes_monto_alto'),
          trx.raw('COUNT(*) FILTER (WHERE duracion_horas >= 10)::int AS turnos_largos'),
          trx.raw('ROUND(SUM(GREATEST(efectivo_diff, 0))::numeric, 2) AS faltante'),
          trx.raw('ROUND(SUM(-LEAST(efectivo_diff, 0))::numeric, 2) AS sobrante'),
          trx.raw('ROUND(SUM(venta_total)::numeric, 2) AS venta'),
        ).first();
      const merma: any = await trx('analytics.stock_ledger').where({ tenant_id: tenantId, clase_mov: 'merma' })
        .select(trx.raw('COUNT(*)::int AS movs'), trx.raw('ROUND(SUM(importe)::numeric, 2) AS monto')).first();
      const disc: any = await trx('reconciliation.discrepancies')
        .where('tenant_id', trx.raw('public.current_tenant_id()')).whereIn('status', ['nuevo', 'en_revision'])
        .select(trx.raw('COUNT(*)::int AS pendientes'), trx.raw("COUNT(*) FILTER (WHERE severity='critical')::int AS criticos")).first();

      const topCajeros = await trx('analytics.cash_cuts as cc').where('cc.tenant_id', tenantId)
        .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
          this.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre');
        })
        .whereRaw('cc.efectivo_diff >= 50').whereNotNull('cc.cajero_cierre')
        .groupBy('cc.warehouse_code', 'cc.cajero_cierre', 'pc.nombre')
        .select('cc.warehouse_code', 'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'),
          trx.raw('COUNT(*)::int AS eventos'),
          trx.raw('ROUND(SUM(cc.efectivo_diff)::numeric, 2) AS faltante'))
        .orderByRaw('SUM(cc.efectivo_diff) DESC').limit(10);

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

      const cuadreExacto = Number(caja?.cuadre_exacto || 0);
      const cortesAlto = Number(caja?.cortes_monto_alto || 0);
      return {
        caja: {
          cortes: Number(caja?.cortes || 0), con_descuadre: Number(caja?.con_descuadre || 0),
          descuadre_no_efectivo: Number(caja?.descuadre_no_efectivo || 0),
          cuadre_exacto: cuadreExacto, cortes_monto_alto: cortesAlto,
          pct_exacto: cortesAlto ? Math.round((cuadreExacto / cortesAlto) * 100) : 0,
          turnos_largos: Number(caja?.turnos_largos || 0),
          faltante: Number(caja?.faltante || 0), sobrante: Number(caja?.sobrante || 0), venta: Number(caja?.venta || 0),
        },
        inventario: { mermas: Number(merma?.movs || 0), monto_merma: Number(merma?.monto || 0) },
        descuadres: { pendientes: Number(disc?.pendientes || 0), criticos: Number(disc?.criticos || 0) },
        top_cajeros: topCajeros.map((r: any) => ({ sucursal: r.warehouse_code, cajero: r.cajero_cierre, cajero_nombre: r.cajero_nombre || null, eventos: Number(r.eventos), faltante: Number(r.faltante) })),
        por_sucursal: porSucursal.map((r: any) => ({ sucursal: r.warehouse_code, cortes: Number(r.cortes), faltante_caja: Number(r.faltante), merma: mermaMap[r.warehouse_code] || 0 })),
      };
    });
  }

  /** Cortes de caja (data cruda) — tab Cortes. */
  async cashCuts(q: { sucursal?: string; cajero?: string; from?: string; to?: string; min_diff?: number; solo_descuadres?: boolean; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.cash_cuts as cc').where('cc.tenant_id', tenantId)
        .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
          this.on('pc.tenant_id', '=', 'cc.tenant_id').andOn('pc.warehouse_code', '=', 'cc.warehouse_code').andOn('pc.cajero_code', '=', 'cc.cajero_cierre');
        })
        .select('cc.id', 'cc.warehouse_code', 'cc.warehouse_name', 'cc.caja', 'cc.folio', 'cc.business_date',
          'cc.cajero_cierre', trx.raw('pc.nombre AS cajero_nombre'), 'cc.cajero_apertura', 'cc.turno',
          'cc.hora_apertura', 'cc.hora_cierre', trx.raw('cc.duracion_horas::numeric AS duracion_horas'),
          trx.raw('(cc.cajero_apertura IS DISTINCT FROM cc.cajero_cierre) AS handoff'),
          trx.raw('efectivo_esperado::numeric AS efectivo_esperado'), trx.raw('efectivo_contado::numeric AS efectivo_contado'),
          trx.raw('efectivo_diff::numeric AS efectivo_diff'),
          trx.raw('tarjeta_esperado::numeric AS tarjeta_esperado'), trx.raw('tarjeta_contado::numeric AS tarjeta_contado'), trx.raw('tarjeta_diff::numeric AS tarjeta_diff'),
          trx.raw('transfer_esperado::numeric AS transfer_esperado'), trx.raw('transfer_contado::numeric AS transfer_contado'), trx.raw('transfer_diff::numeric AS transfer_diff'),
          trx.raw('arqueo_billetes::numeric AS arqueo_billetes'), trx.raw('arqueo_monedas::numeric AS arqueo_monedas'), trx.raw('arqueo_otros::numeric AS arqueo_otros'),
          trx.raw('efectivo_retirado::numeric AS efectivo_retirado'),
          trx.raw('venta_total::numeric AS venta_total'), trx.raw('total_venta::numeric AS total_venta'),
          trx.raw('(efectivo_diff = 0 AND efectivo_esperado >= 3000) AS cuadre_exacto'))
        .orderBy('cc.business_date', 'desc').orderByRaw('abs(efectivo_diff) DESC').limit(limit);
      if (q.sucursal) b.where('cc.warehouse_code', q.sucursal);
      if (q.cajero) b.whereRaw('(cc.cajero_cierre ILIKE ? OR pc.nombre ILIKE ?)', [`%${q.cajero}%`, `%${q.cajero}%`]);
      if (q.from) b.where('cc.business_date', '>=', q.from);
      if (q.to) b.where('cc.business_date', '<=', q.to);
      if (q.solo_descuadres) b.whereRaw('(abs(efectivo_diff) >= ? OR abs(tarjeta_diff) >= ? OR abs(transfer_diff) >= ?)', [Number(q.min_diff) || 50, Number(q.min_diff) || 50, Number(q.min_diff) || 50]);
      else if (q.min_diff) b.whereRaw('abs(efectivo_diff) >= ?', [Number(q.min_diff)]);
      const rows = await b;
      const n = (v: any) => Number(v);
      return rows.map((r: any) => ({
        ...r,
        efectivo_esperado: n(r.efectivo_esperado), efectivo_contado: n(r.efectivo_contado), efectivo_diff: n(r.efectivo_diff),
        tarjeta_esperado: n(r.tarjeta_esperado), tarjeta_contado: n(r.tarjeta_contado), tarjeta_diff: n(r.tarjeta_diff),
        transfer_esperado: n(r.transfer_esperado), transfer_contado: n(r.transfer_contado), transfer_diff: n(r.transfer_diff),
        arqueo_billetes: n(r.arqueo_billetes), arqueo_monedas: n(r.arqueo_monedas), arqueo_otros: n(r.arqueo_otros),
        efectivo_retirado: n(r.efectivo_retirado), venta_total: n(r.venta_total), total_venta: n(r.total_venta),
        duracion_horas: r.duracion_horas != null ? Number(r.duracion_horas) : null,
      }));
    });
  }

  /** Movimientos de inventario (data cruda) — tab Movimientos. */
  async movements(q: { clase_mov?: string; sucursal?: string; sku?: string; from?: string; to?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.stock_ledger as sl').where('sl.tenant_id', tenantId)
        .leftJoin('public.products as p', function (this: any) {
          this.on('p.sku', '=', 'sl.sku').andOn('p.tenant_id', '=', 'sl.tenant_id');
        })
        .select('sl.id', 'sl.warehouse_code', 'sl.almacen', 'sl.sku', 'sl.clase_mov', 'sl.grupo', 'sl.folio', 'sl.unidad',
          trx.raw('p.nombre AS producto'),
          trx.raw('sl.unidades::numeric AS unidades'), trx.raw('sl.importe::numeric AS importe'), 'sl.fecha')
        .orderBy('sl.fecha', 'desc').orderByRaw('sl.importe DESC').limit(limit);
      if (q.clase_mov) b.where('sl.clase_mov', q.clase_mov);
      if (q.sucursal) b.where('sl.warehouse_code', q.sucursal);
      if (q.sku) b.whereRaw('(sl.sku ILIKE ? OR p.nombre ILIKE ?)', [`%${q.sku}%`, `%${q.sku}%`]);
      if (q.from) b.where('sl.fecha', '>=', q.from);
      if (q.to) b.where('sl.fecha', '<=', q.to);
      const rows = await b;
      return rows.map((r: any) => ({ ...r, unidades: Number(r.unidades), importe: Number(r.importe) }));
    });
  }
}
