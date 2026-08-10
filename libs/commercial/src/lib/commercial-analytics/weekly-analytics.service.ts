import { BadRequestException, Injectable } from '@nestjs/common';
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

export interface RangeQuery {
  /** Inicio del rango (ISO 'YYYY-MM-DD', inclusivo). */
  from?: string;
  /** Fin del rango (ISO 'YYYY-MM-DD', inclusivo). */
  to?: string;
  /** Código de sucursal. Forzado por el controller si el user está scopeado. */
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

  /**
   * Análisis por RANGO PERSONALIZADO para el encargado de sucursal (/tienda/analisis-semanal).
   *
   * A diferencia de weekly(): rango libre [from,to] + métricas de operación de tienda que la
   * vista semanal no daba: **tickets**, **ticket promedio ($/ticket)** y **productos por ticket**
   * (líneas/ticket). Compara contra el período INMEDIATAMENTE anterior del MISMO tamaño.
   *
   * Fuentes:
   *  - `analytics.sales_daily` → venta $, margen, unidades (Kepler+Wincaja).
   *  - `analytics.product_sales_daily` → unidades oficiales + top productos.
   *  - `wincaja.maestro_mov_almacen` (grano DOCUMENTO=ticket, tipo='V', no cancelado) +
   *    `detalles_mov_almacen` (líneas) → tickets y líneas reales. Mapea a la sucursal vía
   *    `wincaja.branches.warehouse_code`. Es Wincaja-only (el POS de la tienda); sucursales/
   *    períodos sin Wincaja muestran tickets=0 (los KPIs $ igual salen de sales_daily).
   *
   * analytics.* sin RLS → tenant explícito, todo en tk.run(). SET LOCAL statement_timeout
   * como en sell-out: acota el toque a maestro/detalles y protege el pool.
   */
  async range(q: RangeQuery): Promise<any> {
    const tenantId = this.tenantCtx.requireTenantId();
    const wh = (q.warehouse_code || '').trim() || null;
    const iso = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
    const from = iso(q.from);
    const to = iso(q.to);
    if (!from || !to) throw new BadRequestException('from/to requeridos (YYYY-MM-DD)');
    if (from > to) throw new BadRequestException('from posterior a to');
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > 400) throw new BadRequestException('rango máximo 400 días');
    const toExcl = addDays(to, 1);            // exclusivo (sale_date < toExcl)
    const prevFrom = addDays(from, -days);    // período previo del mismo tamaño
    const prevToExcl = from;                  // exclusivo = from (previo termina el día antes)

    const whClause = wh ? `AND w.code = ?` : ``;
    const whBind = wh ? [wh] : [];

    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '30s'`);

      // 1) KPIs $ / margen / unidades (sales_daily), cur vs previo.
      const sd: any = await trx.raw(
        `SELECT COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_cur,
                COALESCE(sum(sd.revenue) FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS rev_prev,
                COALESCE(sum(sd.margin)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_cur,
                COALESCE(sum(sd.margin)  FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS mar_prev,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_cur,
                COALESCE(sum(sd.units)   FILTER (WHERE sd.sale_date >= ? AND sd.sale_date < ?),0)::float AS uni_prev
           FROM analytics.sales_daily sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}`,
        [from, toExcl, prevFrom, prevToExcl, from, toExcl, prevFrom, prevToExcl,
         from, toExcl, prevFrom, prevToExcl, tenantId, prevFrom, toExcl, ...whBind],
      );
      // 2) Unidades oficiales (product_sales_daily).
      const psd: any = await trx.raw(
        `SELECT COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_cur,
                COALESCE(sum(psd.units) FILTER (WHERE psd.sale_date >= ? AND psd.sale_date < ?),0)::float AS off_prev
           FROM analytics.product_sales_daily psd
           JOIN commercial.warehouses w ON w.id = psd.warehouse_id
          WHERE psd.tenant_id = ? AND psd.sale_date >= ? AND psd.sale_date < ? ${whClause}`,
        [from, toExcl, prevFrom, prevToExcl, tenantId, prevFrom, toExcl, ...whBind],
      );
      // 3) Tickets de TIENDA (mostrador, NO ruta) + líneas, por (sucursal, día) para [previo..to].
      //    Fuente unificada por CÓDIGO COMERCIAL, disjunta (sin doble conteo):
      //      · analytics.store_live_tickets → stores '01'–'05' (POS en vivo = lo que ve /tienda/live;
      //        Wincaja está congelado para esas plazas, que ya migraron a Kepler).
      //      · wincaja.maestro_mov_almacen (is_route=false, kepler_code IS NULL) → MD-30/32/50/00.
      //    Excluye rutas (is_route) y evita el desfase branches.warehouse_code('MD-10') vs código '01'
      //    (esos van por kepler_code, que aquí se excluyen del lado Wincaja y se cubren con el POS).
      const prevTo = addDays(prevToExcl, -1);
      // store_live_tickets.warehouse_code YA es el código comercial ('01'..'05'), idéntico a
      // commercial.warehouses.code y al lado maestro ('MD-30'…) → se filtra y agrupa DIRECTO,
      // sin traducir. (Un JOIN a branches.kepler_code lo convertía a 'MD-54' y luego filtraba
      // b2.warehouse_code='05' → 0 filas: ese era el bug de "ticket promedio $0" en sucursales
      // Kepler. El código comercial ya coincide en ambos lados, no hay nada que traducir.)
      const bWh = wh ? `AND warehouse_code = ?` : ``;
      const mWh = wh ? `AND b.warehouse_code = ?` : ``;
      const tkDaily: any = await trx.raw(
        `WITH tk AS (
           SELECT warehouse_code, ticket_ts::date AS d, count(*)::int AS tickets,
                  COALESCE(sum(jsonb_array_length(items)), 0)::int AS lines
             FROM analytics.store_live_tickets
            WHERE tenant_id = ? AND ticket_ts::date >= ? AND ticket_ts::date <= ? ${bWh}
            GROUP BY 1, 2
           UNION ALL
           SELECT b.warehouse_code, m.fecha::date AS d,
                  count(DISTINCT (m.source_branch || '|' || m.consecutivo))::int AS tickets,
                  count(dt.*)::int AS lines
             FROM wincaja.maestro_mov_almacen m
             JOIN wincaja.branches b ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
                                    AND b.is_route = false AND b.kepler_code IS NULL
             LEFT JOIN wincaja.detalles_mov_almacen dt
               ON dt.tenant_id = m.tenant_id AND dt.source_branch = m.source_branch
              AND dt.source_dataset = m.source_dataset AND dt.consecutivo = m.consecutivo AND dt.tipo = 'V'
            WHERE m.tenant_id = ? AND m.tipo = 'V' AND COALESCE(m.cancelado, false) = false
              -- Documento T99 = TRASPASO entre sucursales (tercero = ALMACEN destino), NO ticket
              -- de venta. T98/F70 = mayoreo → SÍ cuentan. Consistente con el poller live y con
              -- el filtro ALMAC% de sales_daily (que ya deja el revenue $ limpio de traspasos).
              AND upper(btrim(m.documento)) NOT LIKE 'T99%'
              AND m.fecha::date >= ? AND m.fecha::date <= ? ${mWh}
            GROUP BY 1, 2
         )
         SELECT warehouse_code, d, sum(tickets)::int AS tickets, sum(lines)::int AS lines
           FROM tk GROUP BY 1, 2`,
        [tenantId, prevFrom, to, ...(wh ? [wh] : []), tenantId, prevFrom, to, ...(wh ? [wh] : [])],
      );
      const inCur = (d: string) => d >= from && d <= to;
      const inPrev = (d: string) => d >= prevFrom && d <= prevTo;
      let tkCur = 0, tkPrev = 0, lnCur = 0, lnPrev = 0;
      const tkByDay = new Map<string, number>();
      const brAgg = new Map<string, { tickets: number; lines: number }>();
      for (const r of tkDaily.rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        const tks = Number(r.tickets) || 0, lns = Number(r.lines) || 0;
        if (inCur(d)) {
          tkCur += tks; lnCur += lns;
          tkByDay.set(d, (tkByDay.get(d) || 0) + tks);
          const a = brAgg.get(r.warehouse_code) || { tickets: 0, lines: 0 };
          a.tickets += tks; a.lines += lns; brAgg.set(r.warehouse_code, a);
        } else if (inPrev(d)) { tkPrev += tks; lnPrev += lns; }
      }
      const s = sd.rows[0], p = psd.rows[0];
      const avg = (rev: number, n: number) => (n > 0 ? rev / n : 0);
      const basket = (ln: number, n: number) => (n > 0 ? ln / n : 0);
      const kpis = {
        revenue: { cur: +s.rev_cur, prev: +s.rev_prev, delta_pct: pct(+s.rev_cur, +s.rev_prev) },
        margin: { cur: +s.mar_cur, prev: +s.mar_prev, delta_pct: pct(+s.mar_cur, +s.mar_prev) },
        units: { cur: +s.uni_cur, prev: +s.uni_prev, delta_pct: pct(+s.uni_cur, +s.uni_prev) },
        units_official: { cur: +p.off_cur, prev: +p.off_prev, delta_pct: pct(+p.off_cur, +p.off_prev) },
        tickets: { cur: tkCur, prev: tkPrev, delta_pct: pct(tkCur, tkPrev) },
        avg_ticket: { cur: avg(+s.rev_cur, tkCur), prev: avg(+s.rev_prev, tkPrev), delta_pct: pct(avg(+s.rev_cur, tkCur), avg(+s.rev_prev, tkPrev)) },
        basket: { cur: basket(lnCur, tkCur), prev: basket(lnPrev, tkPrev), delta_pct: pct(basket(lnCur, tkCur), basket(lnPrev, tkPrev)) },
      };

      // 4) Serie DIARIA (venta + unidades de sales_daily; tickets de tienda de tkByDay).
      const dailySd: any = await trx.raw(
        `SELECT sd.sale_date::date AS d, sum(sd.revenue)::float AS revenue, sum(sd.margin)::float AS margin, sum(sd.units)::float AS units
           FROM analytics.sales_daily sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 1 ORDER BY 1`,
        [tenantId, from, toExcl, ...whBind],
      );
      const series = dailySd.rows.map((r: any) => {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        return { date: d, revenue: +r.revenue, margin: +r.margin, units: +r.units, tickets: tkByDay.get(d) || 0 };
      });

      // 5) Por sucursal (si el user ve más de una): venta/margen/unidades + tickets.
      const branchRes: any = await trx.raw(
        `SELECT w.code, w.name,
                sum(sd.revenue)::float AS revenue, sum(sd.margin)::float AS margin, sum(sd.units)::float AS units
           FROM analytics.sales_daily sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY w.code, w.name ORDER BY revenue DESC`,
        [tenantId, from, toExcl, ...whBind],
      );
      const by_branch = branchRes.rows.map((r: any) => {
        const tks = brAgg.get(r.code)?.tickets || 0;
        return {
          code: r.code, name: r.name, revenue: +r.revenue, margin: +r.margin, units: +r.units,
          tickets: tks, avg_ticket: avg(+r.revenue, tks),
        };
      });

      // 6) Top productos por venta $ + unidades oficiales.
      const prodRes: any = await trx.raw(
        `SELECT sd.product_id, pr.sku, pr.nombre, b.nombre AS brand,
                sum(sd.revenue)::float AS revenue, sum(sd.margin)::float AS margin, sum(sd.units)::float AS units
           FROM analytics.sales_daily sd
           JOIN commercial.warehouses w ON w.id = sd.warehouse_id
           JOIN catalog.products pr ON pr.id = sd.product_id
           LEFT JOIN catalog.brands b ON b.id = pr.brand_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY sd.product_id, pr.sku, pr.nombre, b.nombre
         HAVING sum(sd.revenue) > 0
          ORDER BY revenue DESC LIMIT 50`,
        [tenantId, from, toExcl, ...whBind],
      );
      const by_product = prodRes.rows.map((r: any) => ({
        product_id: r.product_id, sku: r.sku, nombre: r.nombre, brand: r.brand || null,
        revenue: +r.revenue, margin: +r.margin, units: +r.units,
      }));

      return {
        period: { from, to, days },
        prev_period: { from: prevFrom, to: addDays(prevToExcl, -1) },
        scoped_warehouse: wh,
        kpis, series, by_branch, by_product,
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
