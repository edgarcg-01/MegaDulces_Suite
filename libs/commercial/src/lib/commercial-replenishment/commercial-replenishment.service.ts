import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { ReplenishmentScannerService } from './replenishment-scanner.service';

/**
 * RA.4/RA.7 — Fase Reabastecimiento (ADR-030). Proyecto Compras.
 *
 * Reporte de Existencia Crítica (motor determinista, LLM fuera del dinero) +
 * generación de requisiciones (HITL: pending_approval → approved/cancelled).
 *
 *   existencia ⋈ commercial.reorder_policy ⋈ catalog.products ⋈ suppliers ⋈ ABC
 *   bucket:   agotado / bajo_minimo / bajo_reorden / sano / sobrestock
 *   sugerido: max(0, objetivo − existencia − en_tránsito), objetivo = min|reorder|max
 *
 * Todo dentro de TenantKnexService.run() (SET LOCAL app.tenant_id → RLS). Une a
 * catalog.products (NO la vista public.products, que no expone supplier_id/rotación).
 * en_tránsito = 0 hasta RA.5 (feed de OC a recibir).
 */

type TargetBasis = 'min' | 'reorder' | 'max' | 'cadence';
type Bucket = 'agotado' | 'bajo_minimo' | 'bajo_reorden' | 'sano' | 'sobrestock';

export interface CriticalStockQuery {
  warehouse_id?: string;
  warehouse_ids?: string; // RA.12 — CSV de almacenes (multi-sucursal); tiene prioridad sobre warehouse_id
  supplier_id?: string;
  category_id?: string; // RA-PRO.12 — categoría de compra (sourcing, ej. Guadalajara/Arandas)
  abc?: string;
  xyz?: string; // RA-PRO.2 — filtro por clase de variabilidad de demanda
  bucket?: string;
  source?: string;
  search?: string;
  target_basis?: string;
  scope?: string; // 'all' = todo; default = sólo <= punto de reorden (crítico)
  sort_by?: string;  // columna de orden (whitelist en SORTABLE); default = prioridad por valor
  sort_dir?: string; // 'asc' | 'desc'
  page?: number;
  pageSize?: number;
  export?: boolean;  // interno: sube el cap de filas para exportar TODO (XLSX). No expuesto por query param.
}

// RA-PRO.8 — worklist "qué toca" (ciclos de reabasto por almacén×proveedor).
export interface WorklistQuery {
  warehouse_id?: string;
  warehouse_ids?: string; // CSV (territorio del analista)
  via?: string;           // 'purchase' | 'transfer'
  status?: string;        // 'due' = vencido/hoy · default = todos los canales activos
  search?: string;        // nombre de proveedor
  target_basis?: string;  // base global (min|reorder|max) — igual que Existencia Crítica
  category_id?: string;   // RA-PRO.12 — solo canales con productos de esta categoría de compra
  page?: number;
  pageSize?: number;
}

interface RequisitionLineDto {
  product_id: string;
  supplier_id?: string | null;
  source_type?: string;               // RA.11 — 'supplier' (default) | 'branch' (traspaso)
  source_warehouse_id?: string | null; // RA.11 — almacén origen si source_type='branch'
  on_hand?: number;
  in_transit?: number;
  min_stock?: number;
  reorder_point?: number;
  max_stock?: number;
  suggested_qty?: number;
  final_qty: number;
  unit_cost?: number;
}
export interface CreateRequisitionDto {
  warehouse_id: string;
  supplier_id?: string | null;
  source_type?: string;               // RA.11 — origen a nivel requisición (default supplier)
  source_warehouse_id?: string | null;
  target_basis?: string;
  notes?: string;
  lines: RequisitionLineDto[];
}
interface ReceiveLineDto { line_id: string; received_qty: number; }
export interface ReceiveRequisitionDto { lines?: ReceiveLineDto[]; }

const BASES: TargetBasis[] = ['min', 'reorder', 'max', 'cadence'];
const BUCKETS: Bucket[] = ['agotado', 'bajo_minimo', 'bajo_reorden', 'sano', 'sobrestock'];
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CommercialReplenishmentService {
  private readonly logger = new Logger(CommercialReplenishmentService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scanner: ReplenishmentScannerService,
  ) {}

  private basis(v?: string): TargetBasis {
    return BASES.includes(v as TargetBasis) ? (v as TargetBasis) : 'max';
  }
  private targetCol(b: TargetBasis): string {
    return b === 'min' ? 'rp.min_stock' : b === 'reorder' ? 'rp.reorder_point' : 'rp.max_stock';
  }
  /** RA.12 — parsea warehouse_ids (CSV) → UUIDs válidos; fallback a warehouse_id. */
  private whIds(q: { warehouse_ids?: string; warehouse_id?: string }): string[] {
    const raw = (q.warehouse_ids || q.warehouse_id || '').split(',').map((s) => s.trim());
    return raw.filter((s) => UUID_RX.test(s));
  }

  /** Expresiones SQL compartidas (existencia disponible, en tránsito, bucket). */
  private onHand() { return '(COALESCE(s.quantity,0) - COALESCE(s.reserved_quantity,0))'; }
  private inTransit() { return 'COALESCE(pit.qty_in_transit, 0)'; } // RA.5 analytics.purchase_in_transit (OC a recibir)
  // Costo unitario para valorizar el sugerido. Canónico = cost_with_tax (costo vivo por
  // PIEZA desde kdik.c16, saneado 2026-07-15); cost_base (costo_matriz) es fallback — está
  // a escala de CAJA/PAQUETE en muchos granel, lo que inflaba el encargo ~16.6% al
  // multiplicarlo por piezas. Ambos reportes (crítica + /salidas) valorizan igual ahora.
  private costUnit() { return 'COALESCE(pr.cost_with_tax, pr.cost_base, 0)'; }
  // Venta mensual estimada ($) = demanda diaria × 30 × precio de venta (costo × (1+markup)).
  // Usa columnas ya joineadas (ih.avg_daily_units, pr.cost_with_tax, pr.markup_pct) — sin join
  // nuevo. Da el PESO en dinero del producto para priorizar junto al rank por unidades: el #1
  // por velocidad puede mover $500 o $50,000. markup ausente → cae a valor a costo.
  private monthlyRevenue() {
    return 'ROUND(COALESCE(ih.avg_daily_units,0) * 30 * COALESCE(pr.cost_with_tax,0) * (1 + COALESCE(pr.markup_pct,0)/100.0), 2)';
  }
  private bucketExpr() {
    const oh = this.onHand();
    return `CASE
      WHEN ${oh} <= 0 THEN 'agotado'
      WHEN ${oh} <= rp.min_stock THEN 'bajo_minimo'
      WHEN ${oh} <= rp.reorder_point THEN 'bajo_reorden'
      WHEN rp.max_stock > 0 AND ${oh} > rp.max_stock THEN 'sobrestock'
      ELSE 'sano' END`;
  }

  // ── Reporte Existencia Crítica ────────────────────────────────────────
  async criticalStock(q: CriticalStockQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const basis = this.basis(q.target_basis);
    const oh = this.onHand();
    const it = this.inTransit();
    // RA-PRO.9 — base 'cadence' unifica el objetivo con Qué Toca: nivel = demanda ×
    // (cadencia + lead efectivo) + colchón; traspaso = lead interno 1d. Sin canal/cadencia
    // cae al máximo (mismo comportamiento que antes). Las demás bases (min/reorden/máx) intactas.
    // Traspaso: lead de tránsito hub→spoke. NO es deducible del feed (ship↔receive no enlazan,
    // source_branch=dueño no origen; ver reference_kepler_movements_report) → default 3d (topología
    // dice ~3d), afinable por canal vía rc.lead_time_days. Compra: lead del proveedor (o 7 default).
    const effLead = `(CASE WHEN rc.via='transfer' THEN COALESCE(rc.lead_time_days, 3) ELSE COALESCE(rc.lead_time_days, sup.lead_time_days, 7) END)`;
    // RA-PRO.10 — override manual por proveedor: si sup.cadence_days_override está, el objetivo
    // usa horizonte = cadencia_override + colchón (solo COMPRA; el traspaso mantiene su ciclo).
    const cadTarget = `COALESCE(
      CASE
        WHEN sup.cadence_days_override IS NOT NULL AND COALESCE(rc.via,'purchase') <> 'transfer'
          THEN ceil(COALESCE(ih.avg_daily_units,0) * (sup.cadence_days_override + COALESCE(sup.colchon_days,0)))
        WHEN rc.cadence_days IS NOT NULL
          THEN ceil(COALESCE(ih.avg_daily_units,0) * (rc.cadence_days + ${effLead}) + COALESCE(rp.safety_stock,0))
      END, rp.max_stock)`;
    const target = basis === 'cadence' ? cadTarget : this.targetCol(basis);
    const page = Math.max(1, Number(q.page) || 1);
    const cap = q.export ? 100000 : 500;
    const pageSize = Math.min(cap, Math.max(1, Number(q.pageSize) || (q.export ? cap : 50)));

    return this.tk.run(async (trx) => {
      // Ranking POR DINERO (venta/mes est.) RELATIVO al filtro activo: cuando se selecciona
      // un proveedor (o hay búsqueda), #1 = el producto de ESE proveedor que más VENDE EN $
      // en la sucursal — no el rank global. Antes ordenaba por unidades/día, pero la demanda
      // es tan granular (0.01–0.03/día) que empataba en masa (#4 con 3 productos, #6 con 4) y
      // no reflejaba el peso económico. El dinero discrimina y coincide con la columna Venta/mes
      // (mismo orden). Desempate por unidades para productos sin costo (money=0). Sin filtro →
      // rank global $ de la sucursal.
      const rankMoney = 'ih2.avg_daily_units * COALESCE(p2.cost_with_tax,0) * (1 + COALESCE(p2.markup_pct,0)/100.0)';
      const rankBind: any[] = [tenantId];
      let rankFilter = '';
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) { rankFilter += ' AND p2.supplier_id = ?'; rankBind.push(q.supplier_id); }
      if (q.category_id && UUID_RX.test(q.category_id)) { rankFilter += ' AND p2.category_id = ?'; rankBind.push(q.category_id); }
      const rankTerm = (q.search || '').trim();
      if (rankTerm) { rankFilter += ' AND (p2.sku ILIKE ? OR p2.nombre ILIKE ?)'; rankBind.push(`%${rankTerm}%`, `%${rankTerm}%`); }
      const rankSub = trx.raw(
        `(SELECT ih2.warehouse_id, ih2.product_id,
                 DENSE_RANK() OVER (PARTITION BY ih2.warehouse_id ORDER BY ${rankMoney} DESC, ih2.avg_daily_units DESC) AS sales_rank
            FROM analytics.inventory_health ih2
            JOIN catalog.products p2 ON p2.id = ih2.product_id AND p2.tenant_id = ih2.tenant_id
           WHERE ih2.tenant_id = ? AND ih2.avg_daily_units > 0 AND p2.activo = true${rankFilter}) as sr`,
        rankBind);

      const base = trx('commercial.reorder_policy as rp')
        .leftJoin('commercial.stock as s', (j) =>
          j.on('s.tenant_id', 'rp.tenant_id').andOn('s.warehouse_id', 'rp.warehouse_id').andOn('s.product_id', 'rp.product_id'))
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'rp.tenant_id').andOn('w.id', 'rp.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'rp.tenant_id').andOn('sup.id', 'pr.supplier_id'))
        .leftJoin('commercial.abc_classification as abc', (j) =>
          j.on('abc.tenant_id', 'rp.tenant_id').andOn('abc.warehouse_id', 'rp.warehouse_id').andOn('abc.product_id', 'rp.product_id'))
        // RA.5 — analytics.purchase_in_transit (sin RLS → tenant_id explícito en el ON)
        .leftJoin('analytics.purchase_in_transit as pit', (j) =>
          j.on('pit.tenant_id', 'rp.tenant_id').andOn('pit.warehouse_id', 'rp.warehouse_id').andOn('pit.product_id', 'rp.product_id'))
        // RA-PRO.2 — analytics.inventory_health (avg diario para mostrar cobertura; sin RLS)
        .leftJoin('analytics.inventory_health as ih', (j) =>
          j.on('ih.tenant_id', 'rp.tenant_id').andOn('ih.warehouse_id', 'rp.warehouse_id').andOn('ih.product_id', 'rp.product_id'))
        // RA-PRO.9 — canal de reabasto (compra/traspaso + cadencia + próximo) por almacén×proveedor
        .leftJoin('commercial.replenishment_channel as rc', (j) =>
          j.on('rc.tenant_id', 'rp.tenant_id').andOn('rc.warehouse_id', 'rp.warehouse_id').andOn('rc.supplier_id', 'pr.supplier_id'))
        .leftJoin('commercial.warehouses as srcw', (j) =>
          j.on('srcw.tenant_id', 'rp.tenant_id').andOn('srcw.id', 'rc.source_warehouse_id'))
        // Box factor de la etiquetera (fallback de factor_sale para uxc canónico; ver reference_box_factor_factor_sale)
        .leftJoin(
          trx.raw(`(SELECT tenant_id, product_id, max(box_size) AS bs FROM commercial.product_label_prices GROUP BY tenant_id, product_id) as lbl`),
          (j: any) => j.on('lbl.tenant_id', 'rp.tenant_id').andOn('lbl.product_id', 'rp.product_id'))
        // Ranking POR VENTAS relativo al filtro (rankSub arriba): #1 = el que más vende
        // en la sucursal dentro del universo seleccionado. Solo los que venden reciben
        // rank (demanda 0 → NULL vía el leftJoin).
        .leftJoin(rankSub, (j: any) => j.on('sr.warehouse_id', 'rp.warehouse_id').andOn('sr.product_id', 'rp.product_id'))
        .where('rp.tenant_id', tenantId)
        .andWhere('pr.activo', true); // no sugerir reabasto de productos descontinuados

      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('rp.warehouse_id', whIds);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('pr.supplier_id', q.supplier_id);
      if (q.category_id && UUID_RX.test(q.category_id)) base.andWhere('pr.category_id', q.category_id);
      if (q.source && ['kepler', 'computed', 'manual'].includes(q.source)) base.andWhere('rp.source', q.source);
      if (q.abc && ['A', 'B', 'C'].includes(q.abc.toUpperCase())) base.andWhere((b) => b.where('abc.abc_class', q.abc!.toUpperCase()).orWhere('rp.abc_class', q.abc!.toUpperCase()));
      if (q.xyz && ['X', 'Y', 'Z'].includes(q.xyz.toUpperCase())) base.andWhere('rp.xyz_class', q.xyz.toUpperCase());
      if (q.search && q.search.trim()) {
        const s = `%${q.search.trim()}%`;
        base.andWhere((b) => b.whereILike('pr.sku', s).orWhereILike('pr.nombre', s));
      }
      // Filtro por bucket / scope
      if (q.bucket && BUCKETS.includes(q.bucket as Bucket)) {
        base.andWhereRaw(`${this.bucketExpr()} = ?`, [q.bucket]);
      } else if (q.scope !== 'all') {
        base.andWhereRaw(`${oh} <= rp.reorder_point`); // default: crítico (≤ punto de reorden)
      }

      const totalRow: any = await base.clone().clearSelect().clearOrder().count('* as c').first();
      const total = Number(totalRow?.c || 0);

      const rows = await base.clone()
        .select(
          'rp.product_id',
          'rp.warehouse_id',
          trx.raw('w.code AS warehouse_code'),
          trx.raw('pr.sku AS sku'),
          trx.raw('pr.nombre AS nombre'),
          trx.raw(`${oh} AS on_hand`),
          trx.raw(`${it} AS in_transit`),
          'rp.min_stock',
          'rp.reorder_point',
          'rp.max_stock',
          'rp.source',
          // RA-PRO.1/2 — política profesional: safety stock por nivel de servicio + segmentación XYZ
          trx.raw('rp.safety_stock AS safety_stock'),
          trx.raw('rp.service_level AS service_level'),
          trx.raw('rp.xyz_class AS xyz_class'),
          trx.raw('rp.demand_cv AS demand_cv'),
          trx.raw('rp.policy_method AS policy_method'),
          trx.raw('rp.lead_time_days AS lead_time_days'),
          trx.raw('ih.avg_daily_units AS avg_daily_units'),
          // RA-PRO.9 — contexto de canal/ciclo (para columnas y para que el detalle case con Qué Toca)
          trx.raw('rc.via AS replenish_via'),
          trx.raw('rc.cadence_days AS cadence_days'),
          trx.raw('rc.next_due_date AS next_due_date'),
          trx.raw('rc.health_band AS cadence_band'),
          trx.raw('srcw.code AS source_warehouse_code'),
          trx.raw('sr.sales_rank AS sales_rank'), // ranking de ventas en la sucursal (#1 = top)
          trx.raw(`${this.monthlyRevenue()} AS monthly_revenue`), // peso $ del producto (venta/mes est.)
          trx.raw('sup.id AS supplier_id'),
          trx.raw('sup.name AS supplier_name'),
          trx.raw('sup.min_order_boxes AS supplier_min_boxes'),
          trx.raw('sup.min_order_amount AS supplier_min_amount'),
          trx.raw('pr.factor_purchase AS factor_purchase'),
          trx.raw('pr.factor_sale AS factor_sale'), // piezas/caja REAL (factor_purchase está roto); ver reference_box_factor_factor_sale
          trx.raw('lbl.bs AS box_size'),            // fallback de factor_sale para uxc (etiquetera)

          trx.raw('COALESCE(abc.abc_class, rp.abc_class) AS abc_class'),
          trx.raw(`${this.costUnit()} AS unit_cost`),
          trx.raw(`${this.bucketExpr()} AS bucket`),
          trx.raw(`GREATEST(0, ${target} - ${oh} - ${it}) AS suggested_qty`),
          trx.raw(`ROUND(GREATEST(0, ${target} - ${oh} - ${it}) * ${this.costUnit()}, 2) AS suggested_cost`),
        )
        // Dinero primero: el sugerido valorizado ($) manda. Sin esto, los 3k+
        // agotados (muchos SKUs admin/insumo con costo 0) acaparan 60+ páginas
        // con existencia 0 y la vista "parece" rota.
        .modify((qb) => {
          // Sort explícito por columna (whitelist). Si no hay, cae al orden por
          // prioridad de valor (default de negocio). El sugerido default es un
          // desempate útil aún cuando el usuario ordena por otra cosa.
          const sortExpr = this.sortableExpr(q.sort_by, target, oh, it);
          if (sortExpr) {
            const dir = (q.sort_dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            qb.orderByRaw(`${sortExpr} ${dir} NULLS LAST`)
              .orderByRaw(`GREATEST(0, ${target} - ${oh} - ${it}) * ${this.costUnit()} DESC`);
          } else {
            qb.orderByRaw(`GREATEST(0, ${target} - ${oh} - ${it}) * ${this.costUnit()} DESC`)
              .orderByRaw(`CASE ${this.bucketExpr()}
                  WHEN 'agotado' THEN 0 WHEN 'bajo_minimo' THEN 1 WHEN 'bajo_reorden' THEN 2 WHEN 'sobrestock' THEN 4 ELSE 3 END`)
              .orderByRaw(`GREATEST(0, ${target} - ${oh} - ${it}) DESC`);
          }
        })
        .limit(pageSize).offset((page - 1) * pageSize);

      return { total, page, pageSize, target_basis: basis, rows };
    });
  }

  /**
   * Whitelist de columnas ordenables → expresión SQL segura. Devuelve null si
   * la columna no es válida (→ orden por defecto). NUNCA interpola el input del
   * usuario en el SQL: sólo la llave del mapa decide la expresión.
   */
  private sortableExpr(key: string | undefined, target: string, oh: string, it: string): string | null {
    if (!key) return null;
    const map: Record<string, string> = {
      sku: 'pr.sku',
      nombre: 'pr.nombre',
      warehouse_code: 'w.code',
      abc_class: 'COALESCE(abc.abc_class, rp.abc_class)',
      sales_rank: 'sr.sales_rank',
      monthly_revenue: this.monthlyRevenue(),
      on_hand: oh,
      min_stock: 'rp.min_stock',
      reorder_point: 'rp.reorder_point',
      max_stock: 'rp.max_stock',
      safety_stock: 'rp.safety_stock',
      in_transit: it,
      suggested_qty: `GREATEST(0, ${target} - ${oh} - ${it})`,
      suggested_cost: `GREATEST(0, ${target} - ${oh} - ${it}) * ${this.costUnit()}`,
      supplier_name: 'sup.name',
    };
    return map[key] ?? null;
  }

  /** KPIs por bucket (para las tarjetas de la página). */
  async summary(q: CriticalStockQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const basis = this.basis(q.target_basis);
    const target = this.targetCol(basis);
    const oh = this.onHand();
    const it = this.inTransit();
    return this.tk.run(async (trx) => {
      const base = trx('commercial.reorder_policy as rp')
        .leftJoin('commercial.stock as s', (j) =>
          j.on('s.tenant_id', 'rp.tenant_id').andOn('s.warehouse_id', 'rp.warehouse_id').andOn('s.product_id', 'rp.product_id'))
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .leftJoin('analytics.purchase_in_transit as pit', (j) =>
          j.on('pit.tenant_id', 'rp.tenant_id').andOn('pit.warehouse_id', 'rp.warehouse_id').andOn('pit.product_id', 'rp.product_id'))
        .where('rp.tenant_id', tenantId)
        .andWhere('pr.activo', true); // no contar productos descontinuados en los KPIs
      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('rp.warehouse_id', whIds);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('pr.supplier_id', q.supplier_id);

      const r: any = await base
        .select(
          trx.raw(`COUNT(*) FILTER (WHERE ${oh} <= 0)::int AS agotado`),
          trx.raw(`COUNT(*) FILTER (WHERE ${oh} > 0 AND ${oh} <= rp.min_stock)::int AS bajo_minimo`),
          trx.raw(`COUNT(*) FILTER (WHERE ${oh} > rp.min_stock AND ${oh} <= rp.reorder_point)::int AS bajo_reorden`),
          trx.raw(`COUNT(*) FILTER (WHERE rp.max_stock > 0 AND ${oh} > rp.max_stock)::int AS sobrestock`),
          trx.raw('COUNT(*)::int AS total_policies'),
          trx.raw(`ROUND(SUM(GREATEST(0, ${target} - ${oh} - ${it}) * ${this.costUnit()}) FILTER (WHERE ${oh} <= rp.reorder_point), 2) AS sugerido_costo`),
        ).first();
      return r;
    });
  }

  // ── RA-PRO.8 — Worklist "Qué toca" (ciclos de reabasto) ───────────────
  /**
   * Lista, por (almacén × proveedor) con canal ACTIVO, cuándo toca el próximo pedido
   * (next_due) y el sugerido con horizonte de ciclo: objetivo = demanda_diaria ×
   * (cadencia + lead) + colchón; el lead efectivo de un traspaso es ~1d (interno).
   * Agrega el sugerido de todos los SKUs del proveedor en ese almacén. Solo canales
   * activos (última entrega ≤ 2× cadencia) para no arrastrar proveedores muertos.
   * Scopeado por warehouse_ids (territorio del analista).
   */
  async worklist(q: WorklistQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 200));
    const whIds = this.whIds(q);
    return this.tk.run(async (trx) => {
      const oh = '(COALESCE(s.quantity,0)-COALESCE(s.reserved_quantity,0))';
      const it = 'COALESCE(pit.qty_in_transit,0)';
      // Base GLOBAL (como "Objetivo" de Existencia Crítica): el sugerido llena hasta el
      // nivel elegido (máximo/reorden/mínimo) con la MISMA fórmula que criticalStock (que
      // alimenta el drill) → la columna "Costo est." y el detalle SIEMPRE coinciden y
      // reaccionan al filtro base. La cadencia sigue mandando el "cuándo" (next_due).
      const basis = this.basis(q.target_basis);
      const target = this.targetCol(basis);
      const sug = `GREATEST(0, ${target} - ${oh} - ${it})`;
      const cost = `COALESCE(pr.cost_with_tax, pr.cost_base, 0)`;
      // RA-PRO.12 — categoría de compra: el agg (n_skus/sugerido) solo cuenta productos de la categoría.
      const catFrag = q.category_id && UUID_RX.test(q.category_id) ? 'AND pr.category_id = :cat' : '';

      const filters: string[] = [
        `rc.tenant_id = :t`,
        `rc.cadence_days IS NOT NULL`,
        // Activo = recibió dentro de 2×cadencia O de los últimos 60d (piso). Sin el piso, un canal
        // MUY vencido (dejó de comprar, ej. GONAC PH 7 semanas) cae fuera y se esconde justo cuando
        // más urge — dejando solo el traspaso chico. El piso lo mantiene visible como vencido.
        `rc.last_delivery_date >= CURRENT_DATE - GREATEST(rc.cadence_days*2, 60)::int`,
      ];
      const binds: Record<string, unknown> = { t: tenantId };
      if (whIds.length) { filters.push(`rc.warehouse_id IN (${whIds.map((_, i) => `:w${i}`).join(',')})`); whIds.forEach((w, i) => { binds[`w${i}`] = w; }); }
      if (q.via && ['purchase', 'transfer'].includes(q.via)) { filters.push(`rc.via = :via`); binds.via = q.via; }
      if (q.status === 'due') filters.push(`rc.next_due_date <= CURRENT_DATE`);
      if (q.search && q.search.trim()) { filters.push(`sup.name ILIKE :s`); binds.s = `%${q.search.trim()}%`; }
      if (catFrag) {
        filters.push(`EXISTS (SELECT 1 FROM commercial.reorder_policy rpc JOIN catalog.products prc ON prc.tenant_id=rpc.tenant_id AND prc.id=rpc.product_id WHERE rpc.tenant_id=rc.tenant_id AND rpc.warehouse_id=rc.warehouse_id AND prc.supplier_id=rc.supplier_id AND prc.category_id=:cat AND prc.activo=true)`);
        binds.cat = q.category_id;
      }
      const where = filters.join(' AND ');

      const rows = (await trx.raw(`
        SELECT rc.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
               rc.supplier_id, sup.name AS supplier_name,
               rc.via, rc.source_warehouse_id, srcw.code AS source_warehouse_code,
               rc.cadence_days, rc.health_band, rc.last_delivery_date, rc.next_due_date,
               (rc.next_due_date - CURRENT_DATE)::int AS days_to_due,
               COALESCE(rc.lead_time_days, sup.lead_time_days) AS lead_time_days,
               agg.n_skus, agg.n_below, agg.suggested_qty, agg.suggested_cost
          FROM commercial.replenishment_channel rc
          JOIN commercial.warehouses w ON w.tenant_id=rc.tenant_id AND w.id=rc.warehouse_id
          LEFT JOIN catalog.suppliers sup ON sup.tenant_id=rc.tenant_id AND sup.id=rc.supplier_id
          LEFT JOIN commercial.warehouses srcw ON srcw.tenant_id=rc.tenant_id AND srcw.id=rc.source_warehouse_id
          LEFT JOIN LATERAL (
            SELECT count(*)::int n_skus,
                   count(*) FILTER (WHERE below)::int n_below,
                   COALESCE(SUM(sug),0)::numeric AS suggested_qty,
                   COALESCE(ROUND(SUM(sug*unit_cost)::numeric,2),0) AS suggested_cost
              FROM (
                SELECT (${oh} <= rp.reorder_point) AS below, ${sug} AS sug, ${cost} AS unit_cost
                  FROM commercial.reorder_policy rp
                  JOIN catalog.products pr ON pr.tenant_id=rp.tenant_id AND pr.id=rp.product_id
                       AND pr.supplier_id=rc.supplier_id AND pr.activo=true ${catFrag}
                  LEFT JOIN commercial.stock s ON s.tenant_id=rp.tenant_id AND s.warehouse_id=rp.warehouse_id AND s.product_id=rp.product_id
                  LEFT JOIN analytics.inventory_health ih ON ih.tenant_id=rp.tenant_id AND ih.warehouse_id=rp.warehouse_id AND ih.product_id=rp.product_id
                  LEFT JOIN analytics.purchase_in_transit pit ON pit.tenant_id=rp.tenant_id AND pit.warehouse_id=rp.warehouse_id AND pit.product_id=rp.product_id
                 WHERE rp.tenant_id=rc.tenant_id AND rp.warehouse_id=rc.warehouse_id
              ) x
          ) agg ON true
         WHERE ${where}
         ORDER BY rc.next_due_date ASC NULLS LAST, agg.suggested_cost DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, binds)).rows;

      const kpi = (await trx.raw(`
        SELECT count(*)::int total,
               count(*) FILTER (WHERE rc.next_due_date < CURRENT_DATE)::int vencidos,
               count(*) FILTER (WHERE rc.next_due_date = CURRENT_DATE)::int hoy,
               count(*) FILTER (WHERE rc.next_due_date > CURRENT_DATE AND rc.next_due_date <= CURRENT_DATE + 7)::int prox7,
               COALESCE(SUM(rc.cadence_days),0) AS _dummy
          FROM commercial.replenishment_channel rc
          LEFT JOIN catalog.suppliers sup ON sup.tenant_id=rc.tenant_id AND sup.id=rc.supplier_id
         WHERE ${where}`, binds)).rows[0];

      return { total: Number(kpi.total), vencidos: Number(kpi.vencidos), hoy: Number(kpi.hoy), prox7: Number(kpi.prox7), page, pageSize, rows };
    });
  }

  // ── Stock muerto / SIN rotación (mostrar TODO lo no reabastecible) ─────
  /**
   * TODO producto activo SIN política de reorden en el almacén → no rota (0 demanda →
   * import-computed-reorder no le genera política), por eso NO aparece en Existencia
   * Crítica. Muestra TODOS (no solo los que tienen existencia): con stock = capital
   * inmovilizado; sin stock = descontinuado / nunca surtido. `last_activity` = última
   * venta o movimiento en ESE almacén (el "desde cuándo"); NULL = nunca tuvo actividad
   * → el front cae a `created_at` ("alta en catálogo"). Ancla en catalog.products ×
   * almacén gestionado (NO en stock, para no perder los de 0 existencia). Excluye ghosts
   * sin SKU (fantasmas pre-Kepler, ruido). Respeta filtros almacén/proveedor/búsqueda.
   */
  async deadStock(q: CriticalStockQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 50));
    const valueExpr = 'COALESCE(s.quantity,0) * COALESCE(pr.cost_with_tax, pr.cost_base, 0)';
    // GREATEST ignora NULLs → la más reciente entre última venta y último movimiento.
    const lastActivity =
      `GREATEST(
         (SELECT MAX(sd.sale_date) FROM analytics.product_sales_daily sd
           WHERE sd.tenant_id = pr.tenant_id AND sd.product_id = pr.id AND sd.warehouse_id = w.id),
         (SELECT MAX(sm.doc_date) FROM analytics.stock_movements sm
           WHERE sm.tenant_id = pr.tenant_id AND sm.product_id = pr.id AND sm.warehouse_id = w.id))`;
    return this.tk.run(async (trx) => {
      const base = trx('catalog.products as pr')
        // cross join producto × almacén (mismo tenant); luego filtra a los gestionados
        .join('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'pr.tenant_id'))
        .leftJoin('commercial.stock as s', (j) =>
          j.on('s.tenant_id', 'pr.tenant_id').andOn('s.warehouse_id', 'w.id').andOn('s.product_id', 'pr.id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'pr.tenant_id').andOn('sup.id', 'pr.supplier_id'))
        .where('pr.tenant_id', tenantId)
        .andWhere('pr.activo', true)
        .whereNull('w.deleted_at')
        .andWhereRaw(`pr.sku IS NOT NULL AND btrim(pr.sku) <> ''`) // sin ghosts (fantasmas pre-Kepler)
        // solo almacenes que gestionan reorden (tienen alguna política) → excluye CEDIS '00'
        .andWhereRaw(`EXISTS (SELECT 1 FROM commercial.reorder_policy rpw
                        WHERE rpw.tenant_id = w.tenant_id AND rpw.warehouse_id = w.id)`)
        // sin política para ESTE producto×almacén (los con política están en Crítica)
        .andWhereRaw(`NOT EXISTS (SELECT 1 FROM commercial.reorder_policy rp
                        WHERE rp.tenant_id = pr.tenant_id AND rp.warehouse_id = w.id AND rp.product_id = pr.id)`);
      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('w.id', whIds);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('pr.supplier_id', q.supplier_id);
      if (q.search && q.search.trim()) {
        const t = `%${q.search.trim()}%`;
        base.andWhere((b) => b.whereILike('pr.sku', t).orWhereILike('pr.nombre', t));
      }
      const totalRow: any = await base.clone().clearSelect().clearOrder().count('* as c').first();
      const total = Number(totalRow?.c || 0);
      const sumRow: any = await base.clone().clearSelect().clearOrder().select(trx.raw(`ROUND(SUM(${valueExpr}), 2) AS total_value`)).first();
      const rows = await base.clone()
        .select(
          'pr.id as product_id', 'w.id as warehouse_id',
          trx.raw('w.code AS warehouse_code'),
          trx.raw('pr.sku AS sku'), trx.raw('pr.nombre AS nombre'),
          trx.raw('COALESCE(s.quantity,0) AS on_hand'),
          trx.raw('COALESCE(pr.cost_with_tax, pr.cost_base, 0) AS unit_cost'),
          trx.raw(`ROUND(${valueExpr}, 2) AS dead_value`),
          trx.raw(`${lastActivity} AS last_activity`),
          trx.raw('pr.created_at::date AS created_at'),
          trx.raw('sup.name AS supplier_name'),
        )
        // capital inmovilizado primero; luego los de 0 existencia por antigüedad en catálogo
        .orderByRaw(`${valueExpr} DESC, pr.created_at ASC`)
        .limit(pageSize).offset((page - 1) * pageSize);
      return { total, page, pageSize, total_value: Number(sumRow?.total_value || 0), rows };
    });
  }

  /** Almacenes + proveedores con política (para los filtros del frontend). */
  async filters() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const warehouses = await trx('commercial.reorder_policy as rp')
        .join('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'rp.tenant_id').andOn('w.id', 'rp.warehouse_id'))
        .where('rp.tenant_id', tenantId)
        .distinct('w.id as id', 'w.code as code', 'w.name as name').orderBy('w.code');
      const suppliers = await trx('commercial.reorder_policy as rp')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .join('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'rp.tenant_id').andOn('sup.id', 'pr.supplier_id'))
        .where('rp.tenant_id', tenantId)
        .distinct('sup.id as id', 'sup.name as name', 'sup.min_order_boxes as min_order_boxes').orderBy('sup.name');
      // RA-PRO.12 — categorías de compra (sourcing, ej. Guadalajara/Arandas): las que tienen
      // productos activos con política. n_suppliers/n_products alimentan la etiqueta del selector.
      const categories = await trx('commercial.reorder_policy as rp')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .join('catalog.categories as c', (j) => j.on('c.tenant_id', 'pr.tenant_id').andOn('c.id', 'pr.category_id'))
        .where('rp.tenant_id', tenantId).andWhere('pr.activo', true).whereNull('c.deleted_at')
        .groupBy('c.id', 'c.code', 'c.name')
        .select('c.id as id', 'c.code as code', 'c.name as name')
        .countDistinct('pr.supplier_id as n_suppliers')
        .countDistinct('pr.id as n_products')
        .orderBy('c.name');
      return { warehouses, suppliers, categories };
    });
  }

  // ── Requisiciones (HITL) ──────────────────────────────────────────────
  async createRequisition(dto: CreateRequisitionDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!dto?.warehouse_id || !UUID_RX.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const basis = this.basis(dto.target_basis);
    const lines = (dto.lines || []).filter((l) => l && UUID_RX.test(l.product_id) && Number(l.final_qty) > 0);
    if (!lines.length) throw new BadRequestException('La requisición no tiene líneas con cantidad > 0');
    // RA.11 — un traspaso (source_type='branch') exige almacén origen.
    for (const l of lines) {
      if (l.source_type === 'branch' && !(l.source_warehouse_id && UUID_RX.test(l.source_warehouse_id)))
        throw new BadRequestException('Una línea de traspaso requiere almacén origen');
    }
    // Regla de negocio: compra (proveedor) y traspaso (sucursal) NO se mezclan en
    // la misma requisición; y la compra es UNA requisición por proveedor (el frontend
    // ya parte el borrador — esto es la red de seguridad server-side).
    const srcTypes = new Set(lines.map((l) => (l.source_type === 'branch' ? 'branch' : 'supplier')));
    if (srcTypes.size > 1) throw new BadRequestException('Una requisición no puede mezclar compra (proveedor) y traspaso (sucursal) — sepáralas.');
    if (srcTypes.has('supplier')) {
      const sups = new Set(lines.map((l) => l.supplier_id || 'none'));
      if (sups.size > 1) throw new BadRequestException('Una requisición de compra debe ser de un solo proveedor.');
    } else {
      const origins = new Set(lines.map((l) => l.source_warehouse_id || 'none'));
      if (origins.size > 1) throw new BadRequestException('Una requisición de traspaso debe ser de una sola sucursal origen.');
    }
    const hdrBranch = dto.source_type === 'branch';
    const hdrSrcWh = hdrBranch && dto.source_warehouse_id && UUID_RX.test(dto.source_warehouse_id) ? dto.source_warehouse_id : null;
    if (hdrBranch && !hdrSrcWh) throw new BadRequestException('El traspaso requiere almacén origen');

    return this.tk.run(async (trx) => {
      const year = new Date().getFullYear();
      const seqRes = await trx.raw(
        `INSERT INTO commercial.requisition_sequences (tenant_id, year, last_seq) VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_seq = commercial.requisition_sequences.last_seq + 1
         RETURNING last_seq`, [tenantId, year]);
      const seq = seqRes.rows[0].last_seq;
      const folio = `RQ-${year}-${String(seq).padStart(5, '0')}`;

      let totalUnits = 0, totalCost = 0;
      for (const l of lines) { totalUnits += Number(l.final_qty); totalCost += Number(l.final_qty) * Number(l.unit_cost || 0); }

      const [req] = await trx('commercial.purchase_requisitions')
        .insert({
          tenant_id: tenantId, warehouse_id: dto.warehouse_id,
          supplier_id: dto.supplier_id && UUID_RX.test(dto.supplier_id) ? dto.supplier_id : null,
          source_type: hdrBranch ? 'branch' : 'supplier', source_warehouse_id: hdrSrcWh,
          folio, estado: 'pending_approval', target_basis: basis,
          total_lines: lines.length, total_units: totalUnits, total_cost: Number(totalCost.toFixed(4)),
          notes: dto.notes ?? null, created_by: userId,
        })
        .returning(['id', 'folio', 'estado']);

      await trx('commercial.purchase_requisition_lines').insert(lines.map((l) => ({
        tenant_id: tenantId, requisition_id: req.id, product_id: l.product_id,
        supplier_id: l.supplier_id && UUID_RX.test(l.supplier_id) ? l.supplier_id : null,
        source_type: l.source_type === 'branch' ? 'branch' : 'supplier',
        source_warehouse_id: l.source_type === 'branch' && l.source_warehouse_id && UUID_RX.test(l.source_warehouse_id) ? l.source_warehouse_id : null,
        on_hand: Number(l.on_hand || 0), in_transit: Number(l.in_transit || 0),
        min_stock: Number(l.min_stock || 0), reorder_point: Number(l.reorder_point || 0), max_stock: Number(l.max_stock || 0),
        suggested_qty: Number(l.suggested_qty || 0), final_qty: Number(l.final_qty),
        unit_cost: Number(l.unit_cost || 0), line_cost: Number((Number(l.final_qty) * Number(l.unit_cost || 0)).toFixed(4)),
      })));

      this.logger.log(`Requisición ${folio} creada (${lines.length} líneas, ${totalUnits} u) por ${userId ?? 'system'}`);
      return { id: req.id, folio: req.folio, estado: req.estado, total_lines: lines.length, total_units: totalUnits, total_cost: totalCost };
    });
  }

  async listRequisitions(q: { estado?: string; warehouse_id?: string; page?: number; pageSize?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    return this.tk.run(async (trx) => {
      const base = trx('commercial.purchase_requisitions as r')
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'r.tenant_id').andOn('w.id', 'r.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'r.tenant_id').andOn('sup.id', 'r.supplier_id'))
        .where('r.tenant_id', tenantId);
      if (q.estado) base.andWhere('r.estado', q.estado);
      if (q.warehouse_id && UUID_RX.test(q.warehouse_id)) base.andWhere('r.warehouse_id', q.warehouse_id);
      const totalRow: any = await base.clone().clearSelect().clearOrder().count('* as c').first();
      const rows = await base.clone()
        .select('r.id', 'r.folio', 'r.estado', 'r.target_basis', 'r.total_lines', 'r.total_units', 'r.total_cost',
          'r.notes', 'r.created_at', 'r.approved_at', trx.raw('w.code AS warehouse_code'), trx.raw('w.name AS warehouse_name'),
          trx.raw('sup.name AS supplier_name'))
        .orderBy('r.created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize);
      return { total: Number(totalRow?.c || 0), page, pageSize, rows };
    });
  }

  async getRequisition(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const header: any = await trx('commercial.purchase_requisitions as r')
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'r.tenant_id').andOn('w.id', 'r.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'r.tenant_id').andOn('sup.id', 'r.supplier_id'))
        .where({ 'r.tenant_id': tenantId, 'r.id': id })
        .select('r.*', trx.raw('w.code AS warehouse_code'), trx.raw('w.name AS warehouse_name'), trx.raw('sup.name AS supplier_name'))
        .first();
      if (!header) throw new NotFoundException('Requisición no encontrada');
      const lines = await trx('commercial.purchase_requisition_lines as l')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'l.tenant_id').andOn('pr.id', 'l.product_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'l.tenant_id').andOn('sup.id', 'l.supplier_id'))
        .where('l.tenant_id', tenantId).andWhere('l.requisition_id', id)
        .select('l.*', trx.raw('pr.sku AS sku'), trx.raw('pr.nombre AS nombre'), trx.raw('sup.name AS supplier_name'))
        .orderBy('pr.nombre');
      // RA.15 — OC generada desde esta requisición (traza RQ→OC), si existe.
      const po: any = await trx('commercial.purchase_orders')
        .where({ tenant_id: tenantId, requisition_id: id }).whereNot('estado', 'cancelled')
        .select('id', 'folio', 'estado').orderBy('created_at', 'desc').first();
      return { ...header, lines, purchase_order_id: po?.id ?? null, purchase_order_folio: po?.folio ?? null };
    });
  }

  private async setEstado(id: string, from: string, to: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const patch: any = { estado: to, updated_at: trx.fn.now() };
      if (to === 'approved') { patch.approved_by = userId; patch.approved_at = trx.fn.now(); }
      if (to === 'ordered') { patch.ordered_by = userId; patch.ordered_at = trx.fn.now(); }
      if (to === 'received') { patch.received_by = userId; patch.received_at = trx.fn.now(); }
      const n = await trx('commercial.purchase_requisitions')
        .where({ tenant_id: tenantId, id, estado: from }).update(patch);
      if (!n) throw new BadRequestException(`La requisición no está en estado '${from}'`);
      return { id, estado: to };
    });
  }
  approve(id: string) { return this.setEstado(id, 'pending_approval', 'approved'); }
  reject(id: string) { return this.setEstado(id, 'pending_approval', 'cancelled'); }
  /** RA.14 — approved → ordered (OC emitida / exportada al proveedor). */
  markOrdered(id: string) { return this.setEstado(id, 'approved', 'ordered'); }

  /**
   * RA.14 — ordered → received (mercancía entró; espejo de la orden de entrada
   * X-A-40 de Kepler). Captura received_qty por línea (default = final_qty, recepción
   * completa) → base del fill rate (received/final).
   */
  async markReceived(id: string, dto?: ReceiveRequisitionDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const req: any = await trx('commercial.purchase_requisitions')
        .where({ tenant_id: tenantId, id }).first();
      if (!req) throw new NotFoundException('Requisición no encontrada');
      if (req.estado !== 'ordered') throw new BadRequestException(`La requisición no está en estado 'ordered'`);

      const recv = new Map<string, number>();
      for (const l of dto?.lines || []) { if (UUID_RX.test(l.line_id)) recv.set(l.line_id, Math.max(0, Number(l.received_qty) || 0)); }

      const lines = await trx('commercial.purchase_requisition_lines')
        .where({ tenant_id: tenantId, requisition_id: id }).select('id', 'final_qty');
      for (const l of lines) {
        const q = recv.has(l.id) ? recv.get(l.id)! : Number(l.final_qty);
        await trx('commercial.purchase_requisition_lines')
          .where({ tenant_id: tenantId, id: l.id })
          .update({ received_qty: q, received_at: trx.fn.now() });
      }
      await trx('commercial.purchase_requisitions')
        .where({ tenant_id: tenantId, id })
        .update({ estado: 'received', received_by: userId, received_at: trx.fn.now(), updated_at: trx.fn.now() });
      this.logger.log(`Requisición ${req.folio} recibida por ${userId ?? 'system'}`);
      return { id, estado: 'received' };
    });
  }

  // ── RA.8 — Hallazgos de reabastecimiento (bandeja) ────────────────────
  async listFindings(q: { status?: string; kind?: string; warehouse_id?: string; page?: number; pageSize?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 100));
    const status = q.status && ['open', 'resolved'].includes(q.status) ? q.status : 'open';
    return this.tk.run(async (trx) => {
      const base = trx('commercial.replenishment_findings as f')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'f.tenant_id').andOn('pr.id', 'f.product_id'))
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'f.tenant_id').andOn('w.id', 'f.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'pr.tenant_id').andOn('sup.id', 'pr.supplier_id'))
        .where('f.tenant_id', tenantId).andWhere('f.status', status);
      if (q.kind && ['agotado_abc', 'bajo_reorden', 'cadencia_lenta'].includes(q.kind)) base.andWhere('f.kind', q.kind);
      if (q.warehouse_id && UUID_RX.test(q.warehouse_id)) base.andWhere('f.warehouse_id', q.warehouse_id);
      const totalRow: any = await base.clone().clearSelect().clearOrder().count('* as c').first();
      const rows = await base.clone()
        .select('f.id', 'f.kind', 'f.severity', 'f.status', 'f.abc_class', 'f.on_hand', 'f.reorder_point',
          'f.in_transit', 'f.suggested_qty', 'f.suggested_cost', 'f.first_seen_at', 'f.last_seen_at',
          trx.raw('pr.sku AS sku'), trx.raw('pr.nombre AS nombre'),
          trx.raw('w.code AS warehouse_code'), trx.raw('sup.name AS supplier_name'))
        .orderByRaw(`CASE f.severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 ELSE 2 END`)
        .orderBy('f.suggested_cost', 'desc')
        .limit(pageSize).offset((page - 1) * pageSize);
      return { total: Number(totalRow?.c || 0), page, pageSize, status, rows };
    });
  }

  /** RA.8 — dispara el scan del tenant actual (manual). El cron lo corre nocturno. */
  async scanNow() {
    const tenantId = this.tenantCtx.requireTenantId();
    const findings = await this.scanner.scanTenant(tenantId);
    return { findings };
  }

  /** RA.13a — captura manual del pedido mínimo del proveedor EN CAJAS. */
  async setSupplierMinBoxes(supplierId: string, boxes: number | null) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    const val = boxes == null || Number.isNaN(Number(boxes)) ? null : Math.max(0, Number(boxes));
    return this.tk.run(async (trx) => {
      const n = await trx('catalog.suppliers')
        .where({ tenant_id: tenantId, id: supplierId })
        .update({ min_order_boxes: val, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return { id: supplierId, min_order_boxes: val };
    });
  }

  // ── RA-PRO.3 — Parámetros de compra por proveedor (lead time + mínimo) ─
  // Kepler NO codifica lead time real (verificado: 73% de OC→entrada mismo día,
  // promedio negativo → las fechas son artefacto de captura). Se captura manual;
  // alimenta el punto de reorden (avg×lead) y el safety stock (Z×σ×√lead).
  async listSuppliers(q?: { search?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = trx('catalog.suppliers as sup')
        .leftJoin('catalog.products as pr', (j) => j.on('pr.tenant_id', 'sup.tenant_id').andOn('pr.supplier_id', 'sup.id'))
        .where('sup.tenant_id', tenantId);
      if (q?.search && q.search.trim()) base.andWhereILike('sup.name', `%${q.search.trim()}%`);
      return base
        .groupBy('sup.id', 'sup.name', 'sup.lead_time_days', 'sup.min_order_boxes', 'sup.cadence_days_override', 'sup.colchon_days', 'sup.min_order_amount')
        .select('sup.id', 'sup.name',
          trx.raw('sup.lead_time_days AS lead_time_days'),
          trx.raw('sup.min_order_boxes AS min_order_boxes'),
          trx.raw('sup.cadence_days_override AS cadence_days_override'),
          trx.raw('sup.colchon_days AS colchon_days'),
          trx.raw('sup.min_order_amount AS min_order_amount'),
          trx.raw('COUNT(pr.id)::int AS product_count'))
        .orderBy('sup.name');
    });
  }

  // ── RA-PRO.6 — Topología de red de abasto (DRP CEDIS→sucursal) ────────
  /** Almacenes reales con su origen de surtido; is_cedis = referenciado por ≥1 sucursal. */
  async networkTopology() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.warehouses as w')
        .leftJoin('commercial.warehouses as src', (j) => j.on('src.tenant_id', 'w.tenant_id').andOn('src.id', 'w.source_warehouse_id'))
        .where('w.tenant_id', tenantId).whereNull('w.deleted_at').andWhere('w.kind', '<>', 'truck')
        // Excluye almacenes efímeros de tests/procesos (conteo, equipos, caducidad, ventas).
        .andWhereRaw(`w.code !~ '^(INV|TEAMWH|EXPALERT|SOLDEXP|TRUCK)'`)
        .select('w.id', 'w.code', 'w.name', 'w.source_warehouse_id',
          trx.raw('src.code AS source_code'),
          trx.raw(`EXISTS (SELECT 1 FROM commercial.warehouses c WHERE c.tenant_id=w.tenant_id AND c.source_warehouse_id=w.id AND c.deleted_at IS NULL) AS is_cedis`))
        .orderBy('w.code');
      return rows;
    });
  }

  /** RA-PRO.6 — fija de qué almacén (CEDIS) se surte una sucursal (o NULL = es CEDIS). */
  async setWarehouseSource(warehouseId: string, sourceId: string | null) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    if (sourceId != null && !UUID_RX.test(sourceId)) throw new BadRequestException('source_warehouse_id inválido');
    if (sourceId && sourceId === warehouseId) throw new BadRequestException('Un almacén no puede surtirse de sí mismo');
    return this.tk.run(async (trx) => {
      if (sourceId) {
        const src = await trx('commercial.warehouses').where({ tenant_id: tenantId, id: sourceId }).whereNull('deleted_at').first('id');
        if (!src) throw new NotFoundException('Almacén origen no encontrado');
      }
      const n = await trx('commercial.warehouses')
        .where({ tenant_id: tenantId, id: warehouseId })
        .update({ source_warehouse_id: sourceId, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Almacén no encontrado');
      return { id: warehouseId, source_warehouse_id: sourceId };
    });
  }

  /** RA-PRO.3 — captura manual del lead time del proveedor (días). */
  async setSupplierLeadTime(supplierId: string, days: number | null) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    const val = days == null || Number.isNaN(Number(days)) ? null : Math.min(365, Math.max(0, Math.round(Number(days))));
    return this.tk.run(async (trx) => {
      const n = await trx('catalog.suppliers')
        .where({ tenant_id: tenantId, id: supplierId })
        .update({ lead_time_days: val, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return { id: supplierId, lead_time_days: val };
    });
  }

  // ── RA-PRO.10 — Parámetros de pedido + pedido consolidado con mínimo ──
  /** Captura por proveedor: cadencia override (días) + colchón (días) + mínimo en $ y/o cajas. */
  async setSupplierOrderParams(supplierId: string, patch: { cadence_days_override?: number | null; colchon_days?: number | null; min_order_amount?: number | null; min_order_boxes?: number | null }) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    const clampInt = (v: unknown, max: number) => v == null || Number.isNaN(Number(v)) ? null : Math.min(max, Math.max(0, Math.round(Number(v))));
    const clampNum = (v: unknown) => v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Number(v));
    return this.tk.run(async (trx) => {
      const upd: Record<string, unknown> = { updated_at: trx.fn.now() };
      if ('cadence_days_override' in patch) upd.cadence_days_override = clampInt(patch.cadence_days_override, 365);
      if ('colchon_days' in patch) upd.colchon_days = clampInt(patch.colchon_days, 365);
      if ('min_order_amount' in patch) upd.min_order_amount = clampNum(patch.min_order_amount);
      if ('min_order_boxes' in patch) upd.min_order_boxes = clampInt(patch.min_order_boxes, 1000000);
      const n = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).update(upd);
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return { id: supplierId, ...upd, updated_at: undefined };
    });
  }

  /**
   * Pedido CONSOLIDADO al proveedor (todos sus almacenes de COMPRA), con horizonte
   * cadencia+colchón, evaluado contra el mínimo POR PROVEEDOR (total) y — si queda por
   * debajo — SUBIDO al mínimo repartiendo el faltante en los SKUs que más rotan (avg_daily).
   */
  async supplierOrder(supplierId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    return this.tk.run(async (trx) => {
      const sup = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId })
        .first('id', 'name', 'cadence_days_override', 'colchon_days', 'min_order_boxes', 'min_order_amount', 'lead_time_days') as any;
      if (!sup) throw new NotFoundException('Proveedor no encontrado');
      const oh = this.onHand(); const it = this.inTransit();
      const leadDefault = Number(sup.lead_time_days) || 7;
      const cadTarget = `COALESCE(
        CASE
          WHEN :cadOv::int IS NOT NULL THEN ceil(COALESCE(ih.avg_daily_units,0) * (:cadOv::int + COALESCE(:colc::int,0)))
          WHEN rc.cadence_days IS NOT NULL THEN ceil(COALESCE(ih.avg_daily_units,0) * (rc.cadence_days + COALESCE(rc.lead_time_days, ${leadDefault})) + COALESCE(rp.safety_stock,0))
        END, rp.max_stock)`;
      const raw = await trx.raw(`
        SELECT w.code AS warehouse_code, w.id AS warehouse_id, pr.id AS product_id, pr.sku, pr.nombre,
               ${oh} AS on_hand, COALESCE(ih.avg_daily_units,0) AS avg_daily,
               -- piezas/caja canónico: factor_sale si >1, si no box_size (etiquetera), si no 1.
               GREATEST(CASE WHEN pr.factor_sale > 1 THEN pr.factor_sale WHEN lbl.bs > 1 THEN lbl.bs ELSE 1 END, 1) AS uxc,
               COALESCE(pr.cost_with_tax, pr.cost_base, 0) AS unit_cost,
               GREATEST(0, ${cadTarget} - ${oh} - ${it}) AS suggested
          FROM commercial.reorder_policy rp
          JOIN catalog.products pr ON pr.tenant_id=rp.tenant_id AND pr.id=rp.product_id AND pr.supplier_id=:sid AND pr.activo=true
          LEFT JOIN (SELECT tenant_id, product_id, max(box_size) bs FROM commercial.product_label_prices GROUP BY tenant_id, product_id) lbl ON lbl.tenant_id=pr.tenant_id AND lbl.product_id=pr.id
          JOIN commercial.warehouses w ON w.tenant_id=rp.tenant_id AND w.id=rp.warehouse_id AND w.deleted_at IS NULL AND w.kind<>'truck'
          LEFT JOIN commercial.stock s ON s.tenant_id=rp.tenant_id AND s.warehouse_id=rp.warehouse_id AND s.product_id=rp.product_id
          LEFT JOIN analytics.inventory_health ih ON ih.tenant_id=rp.tenant_id AND ih.warehouse_id=rp.warehouse_id AND ih.product_id=rp.product_id
          LEFT JOIN analytics.purchase_in_transit pit ON pit.tenant_id=rp.tenant_id AND pit.warehouse_id=rp.warehouse_id AND pit.product_id=rp.product_id
          LEFT JOIN commercial.replenishment_channel rc ON rc.tenant_id=rp.tenant_id AND rc.warehouse_id=rp.warehouse_id AND rc.supplier_id=pr.supplier_id
         WHERE rp.tenant_id=:t AND COALESCE(rc.via,'purchase')='purchase'`,
        { t: tenantId, sid: supplierId, cadOv: sup.cadence_days_override, colc: sup.colchon_days });
      const lines = (raw.rows as any[])
        .map((r) => ({
          warehouse_code: r.warehouse_code, warehouse_id: r.warehouse_id, product_id: r.product_id, sku: r.sku, nombre: r.nombre,
          on_hand: Number(r.on_hand), avg_daily: Number(r.avg_daily), uxc: Number(r.uxc) || 1, unit_cost: Number(r.unit_cost) || 0,
          suggested: Math.round(Number(r.suggested)), final: Math.round(Number(r.suggested)),
        }))
        .filter((l) => l.suggested > 0);

      const minBoxes = sup.min_order_boxes != null ? Number(sup.min_order_boxes) : null;
      const minAmount = sup.min_order_amount != null ? Number(sup.min_order_amount) : null;
      const tot = () => ({
        cajas: lines.reduce((s, l) => s + l.final / l.uxc, 0),
        amount: lines.reduce((s, l) => s + l.final * l.unit_cost, 0),
      });
      const before = tot();
      const sumAvg = lines.reduce((s, l) => s + Math.max(l.avg_daily, 0), 0) || lines.length || 1;
      let padded = false;
      if (lines.length && minAmount != null && before.amount < minAmount) {
        const short = minAmount - before.amount;
        for (const l of lines) { const w = (Math.max(l.avg_daily, 0) || 1) / sumAvg; if (l.unit_cost > 0) l.final += Math.max(0, Math.round((short * w) / l.unit_cost)); }
        padded = true;
      } else if (lines.length && minBoxes != null && before.cajas < minBoxes) {
        const short = minBoxes - before.cajas;
        for (const l of lines) { const w = (Math.max(l.avg_daily, 0) || 1) / sumAvg; l.final += Math.max(0, Math.round(short * w)) * l.uxc; }
        padded = true;
      }
      const after = tot();
      return {
        supplier: { id: sup.id, name: sup.name, cadence_days_override: sup.cadence_days_override, colchon_days: sup.colchon_days, min_order_boxes: minBoxes, min_order_amount: minAmount },
        padded,
        totals: { cajas: Math.round(after.cajas * 10) / 10, amount: Math.round(after.amount * 100) / 100, lines: lines.length,
                  suggested_cajas: Math.round(before.cajas * 10) / 10, suggested_amount: Math.round(before.amount * 100) / 100 },
        lines: lines.map((l) => ({ ...l, cajas: Math.round((l.final / l.uxc) * 10) / 10, line_cost: Math.round(l.final * l.unit_cost * 100) / 100 })),
      };
    });
  }

  /**
   * RA-PRO — Histórico de COMPRAS al proveedor (Orden de entrada X-A-40 / Wincaja) desde
   * analytics.stock_movements, agrupado por día de entrega → tamaño típico de orden (para
   * juzgar si el sugerido es sano y derivar un mínimo). Opcional: acotar a un almacén de
   * COMPRA (para un renglón de traspaso, pásale el hub origen, que es donde se compra).
   */
  async supplierOrderHistory(supplierId: string, warehouseId?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    if (warehouseId && !UUID_RX.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      const raw = await trx.raw(`
        WITH ords AS (
          SELECT m.doc_date::date AS d, sum(COALESCE(m.amount, m.qty*m.unit_cost)) AS val,
                 sum(m.qty)::int AS pz, count(DISTINCT m.sku)::int AS skus
            FROM analytics.stock_movements m
            JOIN catalog.products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id AND p.supplier_id=:sid
           WHERE m.tenant_id=:t AND m.movement_kind='entrada'
             AND ((m.genero='X' AND m.doc_type='40') OR m.doc_code='WIN_C')
             ${warehouseId ? 'AND m.warehouse_id=:wid' : ''}
           GROUP BY m.doc_date::date)
        SELECT d, round(val)::float AS amount, pz, skus FROM ords ORDER BY d DESC`,
        warehouseId ? { t: tenantId, sid: supplierId, wid: warehouseId } : { t: tenantId, sid: supplierId });
      const rows = (raw.rows as any[]).map((r) => ({ date: r.d, amount: Number(r.amount) || 0, pz: Number(r.pz) || 0, skus: Number(r.skus) || 0 }));
      const n = rows.length;
      if (!n) return { supplier_id: supplierId, warehouse_id: warehouseId ?? null, n_orders: 0, last: null, median_amount: 0, typical_amount: 0, max_amount: 0, since: null, until: null, recent: [] };
      const vals = rows.map((r) => r.amount).sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)];
      const big = vals.filter((v) => v >= median);                 // órdenes "reales" (excluye migajas de fill-in)
      const typical = big.length ? Math.round(big.reduce((s, v) => s + v, 0) / big.length) : Math.round(median);
      return {
        supplier_id: supplierId, warehouse_id: warehouseId ?? null, n_orders: n,
        last: rows[0], median_amount: Math.round(median), typical_amount: typical, max_amount: Math.round(vals[vals.length - 1]),
        since: rows[n - 1].date, until: rows[0].date, recent: rows.slice(0, 6),
      };
    });
  }
}
