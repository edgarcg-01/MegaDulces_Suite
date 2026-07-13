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

  /**
   * KPIs por sucursal: venta, inventario, cartera real, demanda perdida.
   *
   * Lee la MV `wincaja.mv_branch_kpis` (8 filas, precomputada por el feed gold) en
   * vez de re-agregar ~2.6M lineas por request (~7s -> instantaneo). La MV no tiene
   * RLS (limitacion PG) -> filtro tenant explicito via current_tenant_id(). Une
   * `branches` (vivo, RLS ok) para nombre/estado. Si la MV no existe/esta vacia
   * (feed no corrido), cae a la agregacion viva.
   */
  overview() {
    return this.tk.run(async (trx) => {
      const branches = await trx('wincaja.branches').select('source_branch', 'branch_name', 'warehouse_code', 'status', 'kepler_code');
      const mv = await trx('pg_matviews').where({ schemaname: 'wincaja', matviewname: 'mv_branch_kpis' }).select('ispopulated').first();

      const idx = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.source_branch, r]));
      let K: Record<string, any>;

      if (mv?.ispopulated) {
        const kpis = await trx('wincaja.mv_branch_kpis')
          .whereRaw('tenant_id = current_tenant_id()')
          .select('source_branch', 'venta_total', 'unidades', 'inventario_valor', 'skus_stock', 'cartera', 'cartera_clientes', 'venta_perdida', 'faltantes');
        K = idx(kpis);
      } else {
        // Fallback: agregacion viva (secuencial — pg no admite queries concurrentes en la misma trx).
        const sales = await trx('wincaja.v_sales_daily').select('source_branch').sum({ venta_total: 'importe' }).sum({ unidades: 'qty' }).groupBy('source_branch');
        const stock = await trx('wincaja.v_stock').select('source_branch').sum({ inventario_valor: 'valor_inventario' }).count({ skus_stock: '*' }).groupBy('source_branch');
        const ar = await trx('wincaja.v_ar_customer').where('is_internal', false).where('saldo', '>', 0).select('source_branch').sum({ cartera: 'saldo' }).count({ cartera_clientes: '*' }).groupBy('source_branch');
        const lost = await trx('wincaja.v_lost_demand').select('source_branch').sum({ venta_perdida: 'importe_perdido' }).count({ faltantes: '*' }).groupBy('source_branch');
        const S = idx(sales), ST = idx(stock), A = idx(ar), L = idx(lost);
        K = Object.fromEntries(branches.map((b: any) => [b.source_branch, {
          venta_total: S[b.source_branch]?.venta_total, unidades: S[b.source_branch]?.unidades,
          inventario_valor: ST[b.source_branch]?.inventario_valor, skus_stock: ST[b.source_branch]?.skus_stock,
          cartera: A[b.source_branch]?.cartera, cartera_clientes: A[b.source_branch]?.cartera_clientes,
          venta_perdida: L[b.source_branch]?.venta_perdida, faltantes: L[b.source_branch]?.faltantes,
        }]));
      }

      return branches
        .map((b: any) => {
          const k = K[b.source_branch] || {};
          return {
            source_branch: b.source_branch,
            branch_name: b.branch_name,
            warehouse_code: b.warehouse_code,
            status: b.status,
            wincaja_only: b.kepler_code == null,
            venta_total: Number(k.venta_total || 0),
            unidades: Number(k.unidades || 0),
            inventario_valor: Number(k.inventario_valor || 0),
            skus_stock: Number(k.skus_stock || 0),
            cartera: Number(k.cartera || 0),
            cartera_clientes: Number(k.cartera_clientes || 0),
            venta_perdida: Number(k.venta_perdida || 0),
            faltantes: Number(k.faltantes || 0),
          };
        })
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
