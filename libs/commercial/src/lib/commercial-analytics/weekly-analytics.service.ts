import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Análisis SEMANAL (proyecto Tienda, /tienda/analisis-semanal).
 *
 * Agrega on-the-fly datos DIARIOS que ya existen (feeds nightly Kepler) a semana
 * ISO (lunes–domingo, `date_trunc('week', ...)`). No hay tablas ni MVs nuevas.
 *
 * Fuentes ("ambas"):
 *  - `analytics.sales_daily` (ventana 13 meses) → venta $, margen, unidades. Base de
 *    la tendencia (tiene historia) y de todos los KPIs/desgloses monetarios.
 *  - `analytics.product_sales_daily` → unidades OFICIALES (cuadran con el mensual);
 *    se muestran como cifra de reconciliación de la semana + por producto.
 *
 * OJO: `sales_daily.tickets = count(DISTINCT folio)` es por LÍNEA de producto →
 * NO es sumable a nivel semana/sucursal (sobrecuenta). Por eso no se expone tickets.
 *
 * Scoping por sucursal: el controller fuerza `warehouseCode` del usuario (@ReqUser)
 * igual que el resto de /tienda. RLS forzado → todo dentro de `tk.run()` + tenant
 * explícito (analytics.* no tiene RLS).
 */

export interface WeeklyQuery {
  /** Cualquier día de la semana objetivo (ISO 'YYYY-MM-DD'). Default: semana actual MX. */
  week?: string;
  /** Nº de semanas de la tendencia (default 12, máx 26). */
  weeks?: number;
  /** Código de sucursal ('00'..'05'). Forzado por el controller si el user está scopeado. */
  warehouse_code?: string;
}

const MX_TZ = 'America/Mexico_City';
const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class WeeklyAnalyticsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async weekly(q: WeeklyQuery): Promise<any> {
    const tenantId = this.tenantCtx.requireTenantId();
    const weeks = Math.min(26, Math.max(4, Number(q.weeks) || 12));
    const wh = (q.warehouse_code || '').trim() || null;
    const week = q.week && /^\d{4}-\d{2}-\d{2}$/.test(q.week) ? q.week : null;

    return this.tk.run(async (trx) => {
      // 1) Resolver semana de referencia (lunes ISO) + etiqueta, en TZ MX.
      const refRes: any = await trx.raw(
        `SELECT date_trunc('week', COALESCE(?::date, (now() AT TIME ZONE ?)::date))::date AS ws`,
        [week, MX_TZ],
      );
      const refStart: string = (refRes.rows[0].ws instanceof Date)
        ? refRes.rows[0].ws.toISOString().slice(0, 10)
        : String(refRes.rows[0].ws).slice(0, 10);
      const refEnd = addDays(refStart, 7);            // exclusivo
      const prevStart = addDays(refStart, -7);
      const windowStart = addDays(refStart, -(weeks - 1) * 7);
      const label = (ws: string) => this.isoWeekLabel(ws);

      const whClause = wh ? `AND w.code = ?` : ``;
      const whBind = wh ? [wh] : [];

      // 2) Serie de tendencia (sales_daily, historia completa).
      const seriesRes: any = await trx.raw(
        `SELECT date_trunc('week', sd.sale_date)::date AS ws,
                COALESCE(sum(sd.revenue),0)::float AS revenue,
                COALESCE(sum(sd.margin),0)::float  AS margin,
                COALESCE(sum(sd.units),0)::float   AS units
           FROM analytics.sales_daily sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 1 ORDER BY 1`,
        [tenantId, windowStart, refEnd, ...whBind],
      );
      const series = seriesRes.rows.map((r: any) => {
        const ws = r.ws instanceof Date ? r.ws.toISOString().slice(0, 10) : String(r.ws).slice(0, 10);
        return { week_start: ws, label: label(ws), revenue: +r.revenue, margin: +r.margin, units: +r.units };
      });

      // 3) KPIs semana ref vs previa (totales scoped). SD = $ + margen + unidades; PSD = unidades oficiales.
      const kpiSd: any = await trx.raw(
        `SELECT COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.margin)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_cur,
                COALESCE(sum(sd.margin)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_prev,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_prev
           FROM analytics.sales_daily sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}`,
        [refStart, refEnd, prevStart, refStart, refStart, refEnd, prevStart, refStart,
         refStart, refEnd, prevStart, refStart, tenantId, prevStart, refEnd, ...whBind],
      );
      const kpiPsd: any = await trx.raw(
        `SELECT COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_cur,
                COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_prev
           FROM analytics.product_sales_daily psd
           JOIN commercial.warehouses w ON w.id = psd.warehouse_id
          WHERE psd.tenant_id = ? AND psd.sale_date >= ? AND psd.sale_date < ? ${whClause}`,
        [refStart, refEnd, prevStart, refStart, tenantId, prevStart, refEnd, ...whBind],
      );
      const s = kpiSd.rows[0], p = kpiPsd.rows[0];
      const kpis = {
        revenue: { cur: +s.rev_cur, prev: +s.rev_prev, delta_pct: pct(+s.rev_cur, +s.rev_prev) },
        margin: { cur: +s.mar_cur, prev: +s.mar_prev, delta_pct: pct(+s.mar_cur, +s.mar_prev) },
        units: { cur: +s.uni_cur, prev: +s.uni_prev, delta_pct: pct(+s.uni_cur, +s.uni_prev) },
        units_official: { cur: +p.off_cur, prev: +p.off_prev, delta_pct: pct(+p.off_cur, +p.off_prev) },
      };

      // 4) Desglose por sucursal (ref vs previa).
      const branchRes: any = await trx.raw(
        `SELECT w.code, w.name,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.margin)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_prev
           FROM analytics.sales_daily sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY w.code, w.name
          ORDER BY rev_cur DESC`,
        [refStart, refEnd, prevStart, refStart, refStart, refEnd, refStart, refEnd, prevStart, refStart,
         tenantId, prevStart, refEnd, ...whBind],
      );
      const by_branch = branchRes.rows.map((r: any) => ({
        code: r.code, name: r.name,
        revenue: +r.rev_cur, revenue_prev: +r.rev_prev, revenue_delta_pct: pct(+r.rev_cur, +r.rev_prev),
        margin: +r.mar_cur, units: +r.uni_cur, units_prev: +r.uni_prev, units_delta_pct: pct(+r.uni_cur, +r.uni_prev),
      }));

      // 5) Top productos por venta $ (ref vs previa) + unidades oficiales (PSD) para esos SKUs.
      const prodRes: any = await trx.raw(
        `SELECT sd.product_id, pr.sku, pr.nombre, b.nombre AS brand,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur
           FROM analytics.sales_daily sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.brands b ON b.id = pr.brand_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY sd.product_id, pr.sku, pr.nombre, b.nombre
         HAVING COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0) > 0
          ORDER BY rev_cur DESC
          LIMIT 25`,
        [refStart, refEnd, prevStart, refStart, refStart, refEnd,
         tenantId, prevStart, refEnd, ...whBind, refStart, refEnd],
      );
      const by_product = prodRes.rows.map((r: any) => ({
        product_id: r.product_id, sku: r.sku, nombre: r.nombre, brand: r.brand || null,
        revenue: +r.rev_cur, revenue_prev: +r.rev_prev, revenue_delta_pct: pct(+r.rev_cur, +r.rev_prev),
        units: +r.uni_cur,
      }));

      return {
        ref_week: { start: refStart, label: label(refStart) },
        prev_week: { start: prevStart, label: label(prevStart) },
        weeks, scoped_warehouse: wh,
        series, kpis, by_branch, by_product,
      };
    });
  }

  /** Etiqueta ISO 'YYYY-Www' a partir del lunes de la semana. */
  private isoWeekLabel(monday: string): string {
    const d = new Date(monday + 'T00:00:00Z');
    // La semana ISO se numera por el jueves de esa semana.
    const thursday = new Date(d);
    thursday.setUTCDate(d.getUTCDate() + 3);
    const isoYear = thursday.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
  }
}
