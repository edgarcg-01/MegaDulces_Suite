import { Injectable } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Lectura sobre la capa SILVER de Wincaja (`wincaja.v_*`). Fase W / ADR-031.
 *
 * Expone las sucursales del POS Access — en especial las CIEGAS (30/32/50, que
 * Kepler no ve) — al app: venta, existencia, cartera saneada, demanda perdida y
 * auditoria de caja. Las vistas son security_invoker → la RLS aplica; TODO va por
 * `tk.run` (SET LOCAL app.tenant_id) que es obligatorio para leer wincaja.* (RLS).
 *
 * Montos: las vistas ya sanean bronze (costos corruptos, cuentas internas de
 * traspaso ALMAC%). Aun asi la cartera $ es "mejor esfuerzo" (bronze).
 */
@Injectable()
export class WincajaService {
  constructor(private readonly tk: TenantKnexService) {}

  private branchFilter(qb: any, col: string, branch?: string) {
    if (branch && branch !== 'all') qb.where(col, branch);
    return qb;
  }

  /** Crosswalk de las 8 sucursales + estado (viva en Wincaja / en Kepler). */
  branches() {
    return this.tk.run((trx) =>
      trx('wincaja.branches')
        .select('source_branch', 'branch_name', 'kepler_code', 'warehouse_code', 'status', 'notes')
        .orderBy('source_branch'),
    );
  }

  /** KPIs por sucursal: venta, inventario, cartera real, demanda perdida. */
  overview() {
    return this.tk.run(async (trx) => {
      // Secuencial (no Promise.all): pg no permite queries concurrentes sobre la
      // misma conexion/transaccion — concurrente aqui tiraria error -> 500.
      const sales = await trx('wincaja.v_sales_daily').select('source_branch').sum({ importe: 'importe' }).sum({ qty: 'qty' }).groupBy('source_branch');
      const stock = await trx('wincaja.v_stock').select('source_branch').sum({ valor_inventario: 'valor_inventario' }).count({ skus: '*' }).groupBy('source_branch');
      const ar = await trx('wincaja.v_ar_customer').where('is_internal', false).where('saldo', '>', 0).select('source_branch').sum({ ar: 'saldo' }).count({ clientes: '*' }).groupBy('source_branch');
      const lost = await trx('wincaja.v_lost_demand').select('source_branch').sum({ perdido: 'importe_perdido' }).count({ faltantes: '*' }).groupBy('source_branch');
      const branches = await trx('wincaja.branches').select('source_branch', 'branch_name', 'warehouse_code', 'status', 'kepler_code');
      const idx = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.source_branch, r]));
      const S = idx(sales), K = idx(stock), A = idx(ar), L = idx(lost);
      return branches
        .map((b: any) => ({
          source_branch: b.source_branch,
          branch_name: b.branch_name,
          warehouse_code: b.warehouse_code,
          status: b.status,
          wincaja_only: b.kepler_code == null,
          venta_total: Number(S[b.source_branch]?.importe || 0),
          unidades: Number(S[b.source_branch]?.qty || 0),
          inventario_valor: Number(K[b.source_branch]?.valor_inventario || 0),
          skus_stock: Number(K[b.source_branch]?.skus || 0),
          cartera: Number(A[b.source_branch]?.ar || 0),
          cartera_clientes: Number(A[b.source_branch]?.clientes || 0),
          venta_perdida: Number(L[b.source_branch]?.perdido || 0),
          faltantes: Number(L[b.source_branch]?.faltantes || 0),
        }))
        .sort((a, b) => b.venta_total - a.venta_total);
    });
  }

  /** Venta diaria por sucursal (rango opcional). */
  salesDaily(q: { branch?: string; from?: string; to?: string }) {
    return this.tk.run((trx) => {
      const qb = trx('wincaja.v_sales_daily')
        .select('business_date')
        .sum({ importe: 'importe' }).sum({ qty: 'qty' }).sum({ tickets: 'tickets' })
        .groupBy('business_date').orderBy('business_date');
      this.branchFilter(qb, 'source_branch', q.branch);
      if (q.from) qb.where('business_date', '>=', q.from);
      if (q.to) qb.where('business_date', '<=', q.to);
      return qb;
    });
  }

  /** Top SKUs con más venta perdida (demanda insatisfecha, U6). */
  lostDemand(q: { branch?: string; limit?: number }) {
    return this.tk.run((trx) => {
      const qb = trx('wincaja.v_lost_demand')
        .select('sku').max({ in_kepler_catalog: 'in_kepler_catalog' })
        .count({ veces: '*' }).sum({ importe_perdido: 'importe_perdido' }).sum({ qty_faltante: 'qty_faltante' })
        .groupBy('sku').orderBy('importe_perdido', 'desc').limit(Math.min(Number(q.limit) || 50, 500));
      this.branchFilter(qb, 'source_branch', q.branch);
      return qb;
    });
  }

  /** Cartera de clientes reales (excluye cuentas internas de traspaso). */
  cartera(q: { branch?: string; limit?: number }) {
    return this.tk.run((trx) => {
      const qb = trx('wincaja.v_ar_customer')
        .where('is_internal', false).where('saldo', '>', 0)
        .select('source_branch', 'cliente', 'nombre', 'rfc', 'vendedor', 'territorio', 'saldo', 'limite_credito', 'sobre_limite', 'bloqueado')
        .orderBy('saldo', 'desc').limit(Math.min(Number(q.limit) || 100, 1000));
      this.branchFilter(qb, 'source_branch', q.branch);
      return qb;
    });
  }

  /** Auditoria de overrides de supervisor en caja (U12, prevencion). */
  cashAudit(q: { branch?: string }) {
    return this.tk.run(async (trx) => {
      const qb = trx('wincaja.v_cash_authorizations')
        .select('autorizo', 'autorizo_nombre')
        .count({ overrides: '*' }).countDistinct({ cajeros: 'cajero' })
        .groupBy('autorizo', 'autorizo_nombre').orderBy('overrides', 'desc');
      this.branchFilter(qb, 'source_branch', q.branch);
      return qb;
    });
  }
}
