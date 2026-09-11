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
  /**
   * Sucursales visibles, YA resueltas por `ScopeService` en el controller
   * (`[ID.4]` / ADR-050). `null`/ausente = sin filtro (alcance `all`); lista
   * vacía = no ve ninguna. Es lista y no un solo código porque el alcance
   * permite "la suya + la 03".
   */
  warehouse_codes?: string[] | null;
}

export interface RangeQuery {
  /** Inicio del rango (ISO 'YYYY-MM-DD', inclusivo). */
  from?: string;
  /** Fin del rango (ISO 'YYYY-MM-DD', inclusivo). */
  to?: string;
  /** Sucursales visibles ya resueltas por `ScopeService`. Ver `WeeklyQuery`. */
  warehouse_codes?: string[] | null;
}

const MX_TZ = 'America/Mexico_City';
const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
/** Δ% tolerante a razones NO MEDIDAS: si falta cualquiera de los dos lados, no hay delta. */
const pctN = (cur: number | null, prev: number | null): number | null =>
  cur != null && prev != null ? pct(cur, prev) : null;
/**
 * Razón que se DECLARA no medida en vez de imprimir 0 (ADR-056). Sin denominador
 * —p. ej. una sucursal/período sin cobertura de tickets— `0` se lee en pantalla
 * como "el ticket promedio fue de cero", que es una afirmación falsa; `null` se
 * pinta como «—». Las razones viejas (`avg_ticket`, `basket`) conservan su 0 a
 * propósito: cambiarlas es parte del arreglo de cobertura, no de este item.
 */
const ratio = (num: number, den: number): number | null => (num > 0 && den > 0 ? num / den : null);
/**
 * Porcentaje sobre un total. A diferencia de `ratio()`, el numerador SÍ puede ser
 * ≤ 0 y sigue siendo un hecho: un margen negativo (vender bajo costo) es justo lo
 * que hay que ver, no algo que ocultar. Lo que no puede faltar es el total.
 */
const ratioPct = (num: number, total: number): number | null =>
  total > 0 ? Math.round((num / total) * 1000) / 10 : null;
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
    // `null` = sin filtro (alcance `all`). Array vacío = no ve ninguna sucursal,
    // que NO es lo mismo: se respeta y devuelve series en cero.
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
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

      const whClause = whs ? `AND w.code = ANY(?)` : ``;
      const whBind = whs ? [whs] : [];

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
        weeks, scoped_warehouses: whs,
        series, kpis, by_branch, by_product,
      };
    });
  }

  /**
   * Análisis por RANGO PERSONALIZADO para el encargado de sucursal (/tienda/analisis-semanal).
   *
   * A diferencia de weekly(): rango libre [from,to] + métricas de operación de tienda que la
   * vista semanal no daba: **tickets**, **ticket promedio ($/ticket)**, **partidas por ticket**
   * (renglones/ticket), **valor por partida ($/renglón)**, **unidades por ticket** y **valor
   * unitario promedio ($/unidad)**. Compara contra el período INMEDIATAMENTE anterior del MISMO
   * tamaño. Los rótulos son los de `[TDA.P]` en `/tienda/live`: misma palanca, otra ventana.
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
    // `null` = sin filtro (alcance `all`). Array vacío = no ve ninguna sucursal,
    // que NO es lo mismo: se respeta y devuelve series en cero.
    const whs = q.warehouse_codes == null ? null : q.warehouse_codes.map((c) => String(c).trim()).filter(Boolean);
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

    const whClause = whs ? `AND w.code = ANY(?)` : ``;
    const whBind = whs ? [whs] : [];

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
      /**
       * 2b) CLIENTES CON REGISTRO que compraron en el período — el mostrador es
       * mayormente anónimo, así que ésta es la única cifra que dice *quién* compró.
       *
       * Fuente: `analytics.erp_sales_invoices` (vista viva sobre `kepler_ods`, Fase AX).
       * Es un universo DISTINTO del fact: son los documentos emitidos a nombre de un
       * cliente, no la venta agregada — no cuadra contra `revenue` y no debe cuadrar.
       *
       * Dos exclusiones, las dos verificadas contra la base (2026-09-10):
       *  · `cliente_code='CONTADO'` es literalmente el mostrador anónimo (1,129 docs).
       *    Se excluye ESE código y nada más: los códigos numéricos ('45', '103', '10448')
       *    NO son anónimos — son clientes con nombre ("ABARROTES ROSY", "PATRICIA PEREZ")
       *    de sucursales que usan otra numeración. Filtrar por "código que empieza con C"
       *    habría borrado la cartera entera de la 02.
       *  · `canal='TELEMARK'` es TELEVENTA, otro equipo con su propio módulo. Decisión de
       *    negocio (2026-09-10): esta pantalla cuenta mostrador. Pesa: en la 01 son 220
       *    clientes con televenta y 125 sin ella.
       *
       * `as_of` = último día CON documento dentro del período. La vista tiene su propia
       * frescura, distinta de la del fact, y sin declararla un feed atrasado se lee como
       * "no vino nadie".
       */
      const cliWh = whs ? `AND sucursal = ANY(?)` : ``;
      const cli: any = await trx.raw(
        `SELECT count(DISTINCT cliente_code) FILTER (WHERE fecha >= ? AND fecha < ?)::int AS cli_cur,
                count(DISTINCT cliente_code) FILTER (WHERE fecha >= ? AND fecha < ?)::int AS cli_prev,
                COALESCE(sum(total) FILTER (WHERE fecha >= ? AND fecha < ?),0)::float AS rev_cur,
                COALESCE(sum(total) FILTER (WHERE fecha >= ? AND fecha < ?),0)::float AS rev_prev,
                max(fecha) FILTER (WHERE fecha >= ? AND fecha < ?)::text AS as_of
           FROM analytics.erp_sales_invoices
          WHERE tenant_id = ? AND NOT cancelada
            AND cliente_code <> 'CONTADO' AND COALESCE(canal,'') <> 'TELEMARK'
            AND fecha >= ? AND fecha < ? ${cliWh}`,
        [from, toExcl, prevFrom, prevToExcl, from, toExcl, prevFrom, prevToExcl, from, toExcl,
         tenantId, prevFrom, toExcl, ...(whs ? [whs] : [])],
      );
      const cl = cli.rows[0];

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
      const bWh = whs ? `AND warehouse_code = ANY(?)` : ``;
      const mWh = whs ? `AND b.warehouse_code = ANY(?)` : ``;
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
              -- SOLO ventas de PDV (mostrador): se excluyen las cajas con canal especial en
              -- caja_channels — mayoreo_credito(70), preventa_vecinal(15), ruta_bordo(98),
              -- traspaso_almacen(99), almacen(90), compras(95/96). Las cajas de mostrador no
              -- están en esa tabla → se conservan. Consistente con el poller live.
              AND NOT EXISTS (
                SELECT 1 FROM wincaja.caja_channels k
                 WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
                   AND (k.source_branch = m.source_branch OR k.source_branch = '*'))
              AND m.fecha::date >= ? AND m.fecha::date <= ? ${mWh}
            GROUP BY 1, 2
         )
         SELECT warehouse_code, d, sum(tickets)::int AS tickets, sum(lines)::int AS lines
           FROM tk GROUP BY 1, 2`,
        [tenantId, prevFrom, to, ...(whs ? [whs] : []), tenantId, prevFrom, to, ...(whs ? [whs] : [])],
      );
      const inCur = (d: string) => d >= from && d <= to;
      const inPrev = (d: string) => d >= prevFrom && d <= prevTo;
      let tkCur = 0, tkPrev = 0, lnCur = 0, lnPrev = 0;
      const tkByDay = new Map<string, number>();
      const brAgg = new Map<string, { tickets: number; lines: number }>();
      // Días DISTINTOS con ticket, por período: es la cobertura real del POS, que no se
      // puede deducir del total (105 tickets pueden ser 15 días o uno solo).
      const posDaysCur = new Set<string>(), posDaysPrev = new Set<string>();
      for (const r of tkDaily.rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        const tks = Number(r.tickets) || 0, lns = Number(r.lines) || 0;
        if (inCur(d)) {
          tkCur += tks; lnCur += lns;
          tkByDay.set(d, (tkByDay.get(d) || 0) + tks);
          if (tks > 0) posDaysCur.add(d);
          const a = brAgg.get(r.warehouse_code) || { tickets: 0, lines: 0 };
          a.tickets += tks; a.lines += lns; brAgg.set(r.warehouse_code, a);
        } else if (inPrev(d)) { tkPrev += tks; lnPrev += lns; if (tks > 0) posDaysPrev.add(d); }
      }

      // 4) Serie DIARIA del fact (venta + unidades). Se pide sobre [previo..to] —no sólo el
      //    período actual— porque de acá sale también la COBERTURA del período previo, que
      //    es la que decide si el Δ% de las razones cruzadas significa algo.
      const dailySd: any = await trx.raw(
        `SELECT sd.sale_date::date AS d, sum(sd.revenue)::float AS revenue, sum(sd.margin)::float AS margin, sum(sd.units)::float AS units
           FROM analytics.sales_daily sd JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          WHERE sd.tenant_id = ? AND sd.sale_date >= ? AND sd.sale_date < ? ${whClause}
          GROUP BY 1 ORDER BY 1`,
        [tenantId, prevFrom, toExcl, ...whBind],
      );
      const factDaysCur = new Set<string>(), factDaysPrev = new Set<string>();
      const series: { date: string; revenue: number; margin: number; units: number; tickets: number }[] = [];
      for (const r of dailySd.rows) {
        const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
        const rev = +r.revenue;
        if (inCur(d)) {
          if (rev > 0) factDaysCur.add(d);
          series.push({ date: d, revenue: rev, margin: +r.margin, units: +r.units, tickets: tkByDay.get(d) || 0 });
        } else if (inPrev(d) && rev > 0) { factDaysPrev.add(d); }
      }

      /**
       * COBERTURA MEDIDA, no supuesta. Las razones que cruzan las dos fuentes (venta del
       * fact ÷ tickets/partidas del POS) sólo son comparables si ambas cubren los MISMOS
       * días. Un denominador que existe pero cubre 2 de 15 días NO da cero: da un número
       * absurdo —venta de 15 días entre tickets de 2— y eso es peor que el cero, porque
       * parece medido. Medido en `platform_test` el 2026-09-10: el fact traía 15 días y el
       * POS 2 → "valor por partida" salía $6,180.66. Se declara no medido.
       */
      const cubre = (pos: Set<string>, fact: Set<string>) => fact.size > 0 && pos.size >= fact.size;
      const crossCur = cubre(posDaysCur, factDaysCur);
      const crossPrev = cubre(posDaysPrev, factDaysPrev);
      const cross = (num: number, den: number, ok: boolean) => (ok ? ratio(num, den) : null);

      const s = sd.rows[0], p = psd.rows[0];
      const avg = (rev: number, n: number) => (n > 0 ? rev / n : 0);
      const basket = (ln: number, n: number) => (n > 0 ? ln / n : 0);
      const kpis = {
        revenue: { cur: +s.rev_cur, prev: +s.rev_prev, delta_pct: pct(+s.rev_cur, +s.rev_prev) },
        margin: { cur: +s.mar_cur, prev: +s.mar_prev, delta_pct: pct(+s.mar_cur, +s.mar_prev) },
        /**
         * Margen como % de la venta — la cifra que se compara contra el objetivo del
         * negocio (~11.5%), porque el margen en pesos sube y baja con el volumen.
         * Fuente única (`sales_daily`), así que no pasa por la compuerta de cobertura.
         *
         * ⚠️ ADR-051 (enmendado): el costo del fact NO es homogéneo — en la mitad
         * Wincaja es `ValorCosto` real y en la mitad Kepler es `revenue/(1+markup_pct)`,
         * que es álgebra ciega al precio. O sea que en esa mitad el % tiende a
         * reproducir el markup configurado en vez de medir el margen realizado.
         * Medido en las 5 tiendas (30 d): 10.24% mostrador / 10.69% crédito, contra
         * el ~11.5% que reporta el negocio. Sirve para mirar tendencia, no para cerrar.
         */
        margin_pct: { cur: ratioPct(+s.mar_cur, +s.rev_cur), prev: ratioPct(+s.mar_prev, +s.rev_prev), delta_pct: null },
        units: { cur: +s.uni_cur, prev: +s.uni_prev, delta_pct: pct(+s.uni_cur, +s.uni_prev) },
        units_official: { cur: +p.off_cur, prev: +p.off_prev, delta_pct: pct(+p.off_cur, +p.off_prev) },
        tickets: { cur: tkCur, prev: tkPrev, delta_pct: pct(tkCur, tkPrev) },
        avg_ticket: { cur: avg(+s.rev_cur, tkCur), prev: avg(+s.rev_prev, tkPrev), delta_pct: pct(avg(+s.rev_cur, tkCur), avg(+s.rev_prev, tkPrev)) },
        /** Partidas por ticket = RENGLONES del ticket (no piezas). Antes se rotulaba
         *  "productos/ticket", que se confundía con unidades; el cálculo no cambió. */
        basket: { cur: basket(lnCur, tkCur), prev: basket(lnPrev, tkPrev), delta_pct: pct(basket(lnCur, tkCur), basket(lnPrev, tkPrev)) },
        /**
         * Descomposición del ticket, de lo grueso a lo fino: cuánto vale el ticket →
         * cuánto vale cada partida → cuántas unidades se lleva → cuánto vale la unidad.
         *
         * OJO con el universo de cada razón:
         *  · `avg_line` y `units_per_ticket` dividen venta/unidades de TODOS los canales de
         *    la sucursal (incluye `credito` = mayoreo, 13–22% de la venta según plaza) entre
         *    partidas/tickets que son SOLO mostrador → quedan sobrestimadas mientras eso no
         *    se empareje. Misma deuda que `avg_ticket`, no una nueva.
         *  · `avg_unit` es el único limpio: numerador y denominador salen ambos de
         *    `analytics.sales_daily`, mismo universo y misma fila.
         */
        avg_line: { cur: cross(+s.rev_cur, lnCur, crossCur), prev: cross(+s.rev_prev, lnPrev, crossPrev), delta_pct: pctN(cross(+s.rev_cur, lnCur, crossCur), cross(+s.rev_prev, lnPrev, crossPrev)) },
        units_per_ticket: { cur: cross(+s.uni_cur, tkCur, crossCur), prev: cross(+s.uni_prev, tkPrev, crossPrev), delta_pct: pctN(cross(+s.uni_cur, tkCur, crossCur), cross(+s.uni_prev, tkPrev, crossPrev)) },
        avg_unit: { cur: ratio(+s.rev_cur, +s.uni_cur), prev: ratio(+s.rev_prev, +s.uni_prev), delta_pct: pctN(ratio(+s.rev_cur, +s.uni_cur), ratio(+s.rev_prev, +s.uni_prev)) },
        /**
         * Clientes con registro (ver 2b) y lo que compró cada uno en promedio. El
         * promedio se calcula con la venta DE ESOS DOCUMENTOS, no con la venta total
         * de la tienda: dividir la venta de mostrador entre los clientes con nombre
         * daría un número inflado y sin significado.
         */
        customers: { cur: +cl.cli_cur, prev: +cl.cli_prev, delta_pct: pct(+cl.cli_cur, +cl.cli_prev) },
        revenue_per_customer: {
          cur: ratio(+cl.rev_cur, +cl.cli_cur), prev: ratio(+cl.rev_prev, +cl.cli_prev),
          delta_pct: pctN(ratio(+cl.rev_cur, +cl.cli_cur), ratio(+cl.rev_prev, +cl.cli_prev)),
        },
      };

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
        scoped_warehouses: whs,
        /**
         * Hasta qué día alcanza cada fuente DENTRO del período. Van juntas y por
         * separado a propósito: el fact y la facturación se atrasan distinto, y un
         * solo "actualizado hace X" para toda la pantalla sería mentira (ADR-056).
         * `null` = esa fuente no trajo nada en el período.
         */
        as_of: {
          fact: series.length ? series[series.length - 1].date : null,
          customers: cl.as_of || null,
        },
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
