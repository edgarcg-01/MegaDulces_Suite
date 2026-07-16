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

type TargetBasis = 'min' | 'reorder' | 'max';
type Bucket = 'agotado' | 'bajo_minimo' | 'bajo_reorden' | 'sano' | 'sobrestock';

export interface CriticalStockQuery {
  warehouse_id?: string;
  warehouse_ids?: string; // RA.12 — CSV de almacenes (multi-sucursal); tiene prioridad sobre warehouse_id
  supplier_id?: string;
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

const BASES: TargetBasis[] = ['min', 'reorder', 'max'];
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
    const target = this.targetCol(basis);
    const oh = this.onHand();
    const it = this.inTransit();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 50));

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
        // Ranking POR VENTAS relativo al filtro (rankSub arriba): #1 = el que más vende
        // en la sucursal dentro del universo seleccionado. Solo los que venden reciben
        // rank (demanda 0 → NULL vía el leftJoin).
        .leftJoin(rankSub, (j: any) => j.on('sr.warehouse_id', 'rp.warehouse_id').andOn('sr.product_id', 'rp.product_id'))
        .where('rp.tenant_id', tenantId)
        .andWhere('pr.activo', true); // no sugerir reabasto de productos descontinuados

      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('rp.warehouse_id', whIds);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('pr.supplier_id', q.supplier_id);
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
          trx.raw('sr.sales_rank AS sales_rank'), // ranking de ventas en la sucursal (#1 = top)
          trx.raw(`${this.monthlyRevenue()} AS monthly_revenue`), // peso $ del producto (venta/mes est.)
          trx.raw('sup.id AS supplier_id'),
          trx.raw('sup.name AS supplier_name'),
          trx.raw('sup.min_order_boxes AS supplier_min_boxes'),
          trx.raw('pr.factor_purchase AS factor_purchase'),
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

  // ── Stock muerto (existencia SIN política de reorden) ─────────────────
  /**
   * Productos con EXISTENCIA pero SIN política de reorden en ese almacén → no rotan
   * (0 demanda → import-computed-reorder no les genera política), por eso NO aparecen en
   * Existencia Crítica. Es capital inmovilizado: se muestra aparte para liquidar/promover,
   * NO para reabastecer. Respeta los filtros de almacén/proveedor/búsqueda del reporte.
   */
  async deadStock(q: CriticalStockQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 50));
    const valueExpr = 'COALESCE(s.quantity,0) * COALESCE(pr.cost_with_tax, pr.cost_base, 0)';
    return this.tk.run(async (trx) => {
      const base = trx('commercial.stock as s')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 's.tenant_id').andOn('pr.id', 's.product_id'))
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 's.tenant_id').andOn('w.id', 's.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 's.tenant_id').andOn('sup.id', 'pr.supplier_id'))
        .leftJoin('analytics.inventory_health as ih', (j) =>
          j.on('ih.tenant_id', 's.tenant_id').andOn('ih.warehouse_id', 's.warehouse_id').andOn('ih.product_id', 's.product_id'))
        .where('s.tenant_id', tenantId)
        .andWhere('pr.activo', true)
        .andWhereRaw('COALESCE(s.quantity,0) <> 0')
        .andWhereRaw(`NOT EXISTS (SELECT 1 FROM commercial.reorder_policy rp
                        WHERE rp.tenant_id = s.tenant_id AND rp.warehouse_id = s.warehouse_id AND rp.product_id = s.product_id)`)
        // Solo en almacenes que SÍ gestionan reorden (tienen alguna política). Excluye el
        // CEDIS '00', cuyo inventario NO tiene política por diseño (planeación DRP pendiente,
        // RA-PRO.6) → no es stock muerto, es abasto central sin política aún.
        .andWhereRaw(`EXISTS (SELECT 1 FROM commercial.reorder_policy rpw
                        WHERE rpw.tenant_id = s.tenant_id AND rpw.warehouse_id = s.warehouse_id)`);
      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('s.warehouse_id', whIds);
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
          's.product_id', 's.warehouse_id',
          trx.raw('w.code AS warehouse_code'),
          trx.raw('pr.sku AS sku'), trx.raw('pr.nombre AS nombre'),
          trx.raw('COALESCE(s.quantity,0) AS on_hand'),
          trx.raw('COALESCE(ih.avg_daily_units, 0) AS avg_daily_units'),
          trx.raw('COALESCE(pr.cost_with_tax, pr.cost_base, 0) AS unit_cost'),
          trx.raw(`ROUND(${valueExpr}, 2) AS dead_value`),
          trx.raw('sup.name AS supplier_name'),
        )
        .orderByRaw(`${valueExpr} DESC`) // más capital inmovilizado primero
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
      return { warehouses, suppliers };
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
      if (q.kind && ['agotado_abc', 'bajo_reorden'].includes(q.kind)) base.andWhere('f.kind', q.kind);
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
        .groupBy('sup.id', 'sup.name', 'sup.lead_time_days', 'sup.min_order_boxes')
        .select('sup.id', 'sup.name',
          trx.raw('sup.lead_time_days AS lead_time_days'),
          trx.raw('sup.min_order_boxes AS min_order_boxes'),
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
}
