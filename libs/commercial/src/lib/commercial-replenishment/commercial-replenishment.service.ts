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

// RA-PRO.17 — Compra sugerida anclada en el LEDGER de compras reales (analytics.purchase_velocity).
export interface PurchaseSuggestionQuery {
  warehouse_id?: string;
  warehouse_ids?: string;   // CSV
  supplier_id?: string;
  brand_id?: string;
  category_id?: string;
  search?: string;
  coverage_days?: number;   // horizonte de cobertura (default 30 ≈ ciclo mensual real)
  bucket?: string;          // agotado | critico | bajo | sano | sobrestock (por cobertura de red)
  scope?: string;           // 'all' = incluye lo cubierto; default = solo lo que necesita pedido (sug>0)
  page?: number;
  pageSize?: number;
  export?: boolean;
}

// RA-PRO.20 — Traspaso preciso (topología-aware): déficit de sucursal ← superávit del CEDIS que la surte.
export interface TransferSuggestionQuery {
  warehouse_id?: string;    // filtro por sucursal DESTINO
  supplier_id?: string;
  brand_id?: string;
  category_id?: string;
  search?: string;
  coverage_days?: number;   // horizonte del déficit de la sucursal (default 30)
  page?: number;
  pageSize?: number;
  export?: boolean;
}

// RA-PRO.19 — Sobrestock (capital inmovilizado), topología-aware (el CEDIS se mide vs demanda de red).
export interface OverstockQuery {
  warehouse_id?: string;
  supplier_id?: string;
  brand_id?: string;
  category_id?: string;
  search?: string;
  over_days?: number;       // umbral de sobrestock: stock que excede N días de cobertura (default 90)
  page?: number;
  pageSize?: number;
  export?: boolean;
}

// RA-PRO.32 — Réplica del workbook del comprador (una fila por SKU, columnas por PUNTO DE COMPRA
// territorial: PH / Morelia / Zamora + CEDIS). Mapeo por código de almacén (independiente de la
// topología source_warehouse_id → funciona igual en local y prod).
export interface WorkbookQuery {
  supplier_id?: string;
  brand_id?: string;
  category_id?: string;
  search?: string;
  coverage_days?: number;
  scope?: string;
  warehouse_ids?: string;   // CSV de almacenes a mostrar como columnas (una/varias); vacío = todas con stock
  group?: string;           // 'general' = una sola columna agregada (red); default = por sucursal
  page?: number;
  pageSize?: number;
  export?: boolean;         // XLSX: sube el cap de filas para exportar TODO (sin paginar). No expuesto por query param.
  iad?: string;             // RA-PRO.36.2 — filtro de tendencia server-side: 'accel' (IAD≥0.25) | 'decel' (IAD≤−0.25)
  only_overstock?: boolean; // RA-PRO.36.2 — solo productos con sobrestock (algún territorio con >90 días en mano)
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

  // RA-PRO.27 — la migración 20260728170000 (settings + columnas de override) puede ir por
  // detrás del deploy del código (o quedar bloqueada por otra migración del batch). Este check
  // cacheado deja que la personalización DEGRADE a auto+global sin 500 hasta que exista el schema,
  // y se auto-cure cuando aplique. null = aún sin verificar en este proceso.
  private raPro27Ready: boolean | null = null;
  private async personalizationReady(trx: any): Promise<boolean> {
    if (this.raPro27Ready != null) return this.raPro27Ready;
    try {
      const r = await trx.raw(`SELECT to_regclass('commercial.replenishment_settings') IS NOT NULL AS t,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='catalog' AND table_name='suppliers' AND column_name='fill_rate_override') AS c`);
      this.raPro27Ready = !!(r.rows[0]?.t && r.rows[0]?.c);
    } catch { this.raPro27Ready = false; }
    if (!this.raPro27Ready) this.logger.warn('RA-PRO.27: schema de personalización ausente — pedido en modo auto+global (aplica la migración 20260728170000).');
    return this.raPro27Ready;
  }
  private readonly DEFAULT_SETTINGS = { fill_window_days: 180, fill_min_lines: 3, fill_max_inflate: 1.30, default_coverage_days: 30 };

  // RA-PRO.28 — verificación de UNIDAD DE VENTA para no inflar pedidos. Un SKU se vende en
  // unidades distintas por canal (retail pieza/kg, mayoreo caja/cubeta); el ratio de precio
  // implícito (mayoreo $/u ÷ retail $/u) revela el factor real. Deriva dos factores:
  //   SUF = sub-unidades de demanda por UNIDAD DE STOCK (granel=ratio, normal=1) → alinea
  //         la demanda (kg) con la existencia (cubetas).
  //   BF  = unidades de stock por CAJA de pedido (granel=1, bad-fs=round(ratio), normal=factor_sale).
  // Override manual por SKU en commercial.product_unit_overrides (respaldo).
  private uovReady: boolean | null = null;
  private async unitOverrideReady(trx: any): Promise<boolean> {
    if (this.uovReady != null) return this.uovReady;
    try {
      const r = await trx.raw(`SELECT to_regclass('commercial.product_unit_overrides') IS NOT NULL AS t`);
      this.uovReady = !!r.rows[0]?.t;
    } catch { this.uovReady = false; }
    return this.uovReady;
  }
  // RA-PRO.31 — la lógica de ratio de canal, SUF/BF y el factor de caja canónico (RA-PRO.30)
  // vive ahora en el feed database/importers/kepler/import-replenishment-plan.js, que precomputa
  // el fact analytics.replenishment_plan que leen purchaseSuggestion/transferPlan/overstockList.

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
  // Factor de caja POR ALMACÉN, solo para MOSTRAR en cajas. Los almacenes ciegos de Wincaja
  // (MD-30/32/50) guardan la existencia en SU unidad (paquetes en multi-pack), no en piezas como
  // Kepler → dividir por el resolver canónico (c84) daría cajas ~10x bajas. Ahí se usa
  // factor_venta (analytics.wincaja_product_box_factor, set doble-testigo: anida + costo=paquete);
  // el resto usa el resolver c84/etiquetera. Es SOLO display: buckets/orden/costos siguen en la
  // unidad cruda por almacén (auto-consistente), así el sugerido y la clasificación no cambian.
  // Requiere que la query joinee `w` (warehouses), `wcf` y `cbf`. >=1.
  private cajaFactor() {
    return `CASE WHEN w.code IN ('MD-30','MD-32') AND wcf.factor_venta > 1
                 THEN wcf.factor_venta ELSE GREATEST(COALESCE(cbf.box_factor, 1), 1) END`;
  }
  // OC a recibir, en UNIDADES DE STOCK (que es la unidad de `oh`/`target` acá). Sale del fact
  // `analytics.replenishment_plan`, que lo deriva del ODS en cajas → ×bf lo devuelve exacto a
  // unidades de stock (round-trip del mismo bf, sin pérdida). Antes venía de la tabla
  // `analytics.purchase_in_transit`, que se retiró junto con su importer — ver GOTCHAS §25.
  //
  // RA-PRO.45: para DESCONTAR se usa `transit_eff_cajas` — las mismas cajas pesadas por la
  // probabilidad de que la OC efectivamente llegue (curva derivada del ODS: una OC abierta hace
  // 45 días llega el 13.6% de las veces). `transit_cajas` crudo se sigue MOSTRANDO al comprador,
  // porque tiene que cuadrar folio por folio con el diálogo de "En camino". El COALESCE al crudo
  // es el puente para la primera corrida, antes de que el importer pueble la columna nueva.
  private inTransit() { return 'COALESCE(rpl.transit_eff_cajas, rpl.transit_cajas, 0) * COALESCE(rpl.bf, 1)'; }
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
  /**
   * RA-PRO.9/13 — objetivo por CADENCIA de ciclo (compartido por criticalStock y worklist):
   * nivel = demanda_diaria × (cadencia + lead efectivo) + safety; sin canal/cadencia cae al
   * máximo. Override manual por proveedor (sup.cadence_days_override, solo COMPRA) usa
   * cadencia_override + colchón. El lead de traspaso (tránsito hub→spoke) no es deducible del
   * feed → default 3d, afinable por canal (rc.lead_time_days); compra usa lead del proveedor (o 7).
   * Requiere que la query joinee rc/sup/ih/rp con esos alias.
   */
  private cadenceTarget(): string {
    const effLead = `(CASE WHEN rc.via='transfer' THEN COALESCE(rc.lead_time_days, 3) ELSE COALESCE(rc.lead_time_days, sup.lead_time_days, 7) END)`;
    return `COALESCE(
      CASE
        WHEN sup.cadence_days_override IS NOT NULL AND COALESCE(rc.via,'purchase') <> 'transfer'
          THEN ceil(COALESCE(ih.avg_daily_units,0) * (sup.cadence_days_override + COALESCE(sup.colchon_days,0)))
        WHEN rc.cadence_days IS NOT NULL
          THEN ceil(COALESCE(ih.avg_daily_units,0) * (rc.cadence_days + ${effLead}) + COALESCE(rp.safety_stock,0))
      END, rp.max_stock)`;
  }

  // ── Reporte Existencia Crítica ────────────────────────────────────────
  async criticalStock(q: CriticalStockQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const basis = this.basis(q.target_basis);
    const oh = this.onHand();
    const it = this.inTransit();
    const cf = this.cajaFactor(); // divisor por-almacén para MOSTRAR cantidades en cajas (display only)
    // RA-PRO.9 — base 'cadence' unifica el objetivo con Qué Toca (helper cadenceTarget()).
    // Las demás bases (min/reorden/máx) intactas.
    const target = basis === 'cadence' ? this.cadenceTarget() : this.targetCol(basis);
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
        // RA.5 — tránsito desde el fact (sin RLS → tenant_id explícito en el ON)
        .leftJoin('analytics.replenishment_plan as rpl', (j) =>
          j.on('rpl.tenant_id', 'rp.tenant_id').andOn('rpl.warehouse_id', 'rp.warehouse_id').andOn('rpl.product_id', 'rp.product_id'))
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
          trx.raw(`(SELECT tenant_id, product_id, max(box_size) AS bs, max(pack_size) AS ps FROM commercial.product_label_prices GROUP BY tenant_id, product_id) as lbl`),
          (j: any) => j.on('lbl.tenant_id', 'rp.tenant_id').andOn('lbl.product_id', 'rp.product_id'))
        // Factor de caja por-almacén para DISPLAY (cajas): resolver canónico + override Wincaja.
        .leftJoin('analytics.v_product_box_factor as cbf', (j) =>
          j.on('cbf.tenant_id', 'rp.tenant_id').andOn('cbf.product_id', 'rp.product_id'))
        .leftJoin('analytics.wincaja_product_box_factor as wcf', (j) =>
          j.on('wcf.tenant_id', 'rp.tenant_id').andOn('wcf.product_id', 'rp.product_id'))
        // RA-PRO.16 — SUPERÁVIT DE RED por producto: Σ (existencia − máximo) en TODAS las sucursales del tenant.
        // Sirve para cubrir el déficit de una sucursal con el sobrante de otra (traspaso) ANTES de comprar.
        .leftJoin(
          trx.raw(`(SELECT rp2.product_id,
                      SUM(GREATEST(0, (COALESCE(s2.quantity,0) - COALESCE(s2.reserved_quantity,0)) - rp2.max_stock)) AS surplus_total
                    FROM commercial.reorder_policy rp2
                    LEFT JOIN commercial.stock s2 ON s2.tenant_id = rp2.tenant_id AND s2.warehouse_id = rp2.warehouse_id AND s2.product_id = rp2.product_id
                    WHERE rp2.tenant_id = ?
                    GROUP BY rp2.product_id) as sbp`, [tenantId]),
          (j: any) => j.on('sbp.product_id', 'rp.product_id'))
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
          // Cantidades MOSTRADAS en cajas (÷ factor por-almacén). El bucket/orden/costo abajo
          // siguen en la unidad cruda (oh/target sin dividir) → clasificación y $ intactos.
          trx.raw(`ROUND((${oh}) / (${cf}), 1) AS on_hand`),
          trx.raw(`ROUND((${it}) / (${cf}), 1) AS in_transit`),
          trx.raw(`ROUND(rp.min_stock / (${cf}), 1) AS min_stock`),
          trx.raw(`ROUND(rp.reorder_point / (${cf}), 1) AS reorder_point`),
          trx.raw(`ROUND(rp.max_stock / (${cf}), 1) AS max_stock`),
          trx.raw(`(${cf}) AS caja_factor`), // divisor usado (piezas o paquetes por caja)
          'rp.source',
          // RA-PRO.1/2 — política profesional: safety stock por nivel de servicio + segmentación XYZ
          trx.raw(`ROUND(rp.safety_stock / (${cf}), 1) AS safety_stock`),
          trx.raw('rp.service_level AS service_level'),
          trx.raw('rp.xyz_class AS xyz_class'),
          trx.raw('rp.demand_cv AS demand_cv'),
          trx.raw('rp.policy_method AS policy_method'),
          trx.raw('rp.lead_time_days AS lead_time_days'),
          trx.raw(`ROUND(ih.avg_daily_units / (${cf}), 2) AS avg_daily_units`),
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
          trx.raw('lbl.ps AS pack_size'),           // RA-PRO.30 — Pz/Paq; prueba box_size=factor_sale×pack_size

          trx.raw('COALESCE(abc.abc_class, rp.abc_class) AS abc_class'),
          trx.raw(`${this.costUnit()} AS unit_cost`),
          trx.raw(`${this.bucketExpr()} AS bucket`),
          trx.raw(`ROUND(GREATEST(0, ${target} - ${oh} - ${it}) / (${cf}), 1) AS suggested_qty`),
          trx.raw(`ROUND(GREATEST(0, ${target} - ${oh} - ${it}) * ${this.costUnit()}, 2) AS suggested_cost`),
          // RA-PRO.16 — Redistribución: cubrir el sugerido con sobrante de OTRA sucursal antes de comprar.
          trx.raw(`ROUND(GREATEST(0, ${oh} - rp.max_stock) / (${cf}), 1) AS surplus_here`),                                  // sobrante en ESTE almacén (traspasar a otra)
          trx.raw(`ROUND(GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock)) / (${cf}), 1) AS surplus_network`), // sobrante del producto en OTRAS sucursales
          trx.raw(`ROUND(LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock))) / (${cf}), 1) AS transfer_in`), // cubrible por traspaso
          trx.raw(`ROUND(GREATEST(0, GREATEST(0, ${target} - ${oh} - ${it}) - LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock)))) / (${cf}), 1) AS buy_qty`), // compra REAL (residual)
          trx.raw(`ROUND(GREATEST(0, GREATEST(0, ${target} - ${oh} - ${it}) - LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock)))) * ${this.costUnit()}, 2) AS buy_cost`),
          trx.raw(`CASE
              WHEN GREATEST(0, ${oh} - rp.max_stock) > 0 THEN 'sobrante'
              WHEN LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock))) > 0
                   AND GREATEST(0, ${target} - ${oh} - ${it}) - LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock))) <= 0 THEN 'traspaso'
              WHEN LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock))) > 0 THEN 'traspaso_parcial'
              WHEN GREATEST(0, ${target} - ${oh} - ${it}) > 0 THEN 'comprar'
              ELSE 'ok' END AS accion`),
        )
        // Dinero primero: el sugerido valorizado ($) manda. Sin esto, los 3k+
        // agotados (muchos SKUs admin/insumo con costo 0) acaparan 60+ páginas
        // con existencia 0 y la vista "parece" rota.
        .modify((qb) => {
          // Sort explícito por columna (whitelist). Si no hay, cae al orden por
          // prioridad de valor (default de negocio). El sugerido default es un
          // desempate útil aún cuando el usuario ordena por otra cosa.
          const sortExpr = this.sortableExpr(q.sort_by, target, oh, it, cf);
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
  private sortableExpr(key: string | undefined, target: string, oh: string, it: string, cf = '1'): string | null {
    if (!key) return null;
    // Cantidades se ordenan en CAJAS (÷ factor por-almacén) para casar con lo que se muestra;
    // así ordenar por Existencia compara cajas reales entre almacenes, no unidades crudas mixtas.
    const map: Record<string, string> = {
      sku: 'pr.sku',
      nombre: 'pr.nombre',
      warehouse_code: 'w.code',
      abc_class: 'COALESCE(abc.abc_class, rp.abc_class)',
      sales_rank: 'sr.sales_rank',
      monthly_revenue: this.monthlyRevenue(),
      on_hand: `(${oh}) / (${cf})`,
      min_stock: `rp.min_stock / (${cf})`,
      reorder_point: `rp.reorder_point / (${cf})`,
      max_stock: `rp.max_stock / (${cf})`,
      safety_stock: `rp.safety_stock / (${cf})`,
      in_transit: `(${it}) / (${cf})`,
      suggested_qty: `GREATEST(0, ${target} - ${oh} - ${it}) / (${cf})`,
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
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'rp.tenant_id').andOn('w.id', 'rp.warehouse_id'))
        .leftJoin('analytics.v_product_box_factor as cbf', (j) =>
          j.on('cbf.tenant_id', 'rp.tenant_id').andOn('cbf.product_id', 'rp.product_id'))
        .leftJoin('analytics.wincaja_product_box_factor as wcf', (j) =>
          j.on('wcf.tenant_id', 'rp.tenant_id').andOn('wcf.product_id', 'rp.product_id'))
        .leftJoin('analytics.replenishment_plan as rpl', (j) =>
          j.on('rpl.tenant_id', 'rp.tenant_id').andOn('rpl.warehouse_id', 'rp.warehouse_id').andOn('rpl.product_id', 'rp.product_id'))
        // RA-PRO.16 — superávit de red por producto (para el $ traspasable vs compra real del filtro)
        .leftJoin(
          trx.raw(`(SELECT rp2.product_id, SUM(GREATEST(0, (COALESCE(s2.quantity,0) - COALESCE(s2.reserved_quantity,0)) - rp2.max_stock)) AS surplus_total
                    FROM commercial.reorder_policy rp2
                    LEFT JOIN commercial.stock s2 ON s2.tenant_id = rp2.tenant_id AND s2.warehouse_id = rp2.warehouse_id AND s2.product_id = rp2.product_id
                    WHERE rp2.tenant_id = ? GROUP BY rp2.product_id) as sbp`, [tenantId]),
          (j: any) => j.on('sbp.product_id', 'rp.product_id'))
        .where('rp.tenant_id', tenantId)
        .andWhere('pr.activo', true); // no contar productos descontinuados en los KPIs
      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('rp.warehouse_id', whIds);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('pr.supplier_id', q.supplier_id);
      if (q.category_id && UUID_RX.test(q.category_id)) base.andWhere('pr.category_id', q.category_id);
      // Filtro por nombre de proveedor (el cockpit filtra por nombre, no por id).
      if (q.search && q.search.trim()) {
        base.join('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'rp.tenant_id').andOn('sup.id', 'pr.supplier_id'))
          .andWhereRaw('sup.name ILIKE ?', [`%${q.search.trim()}%`]);
      }
      const cost = this.costUnit();
      const cf = this.cajaFactor(); // divisor por-almacén para SUMar cajas reales (display)

      const r: any = await base
        .select(
          trx.raw(`COUNT(*) FILTER (WHERE ${oh} <= 0)::int AS agotado`),
          trx.raw(`COUNT(*) FILTER (WHERE ${oh} > 0 AND ${oh} <= rp.min_stock)::int AS bajo_minimo`),
          trx.raw(`COUNT(*) FILTER (WHERE ${oh} > rp.min_stock AND ${oh} <= rp.reorder_point)::int AS bajo_reorden`),
          trx.raw(`COUNT(*) FILTER (WHERE rp.max_stock > 0 AND ${oh} > rp.max_stock)::int AS sobrestock`),
          trx.raw('COUNT(*)::int AS total_policies'),
          trx.raw(`ROUND(SUM(GREATEST(0, ${target} - ${oh} - ${it}) * ${cost}) FILTER (WHERE ${oh} <= rp.reorder_point), 2) AS sugerido_costo`),
          // RA-PRO.16 — del sugerido, cuánto se cubre con TRASPASO (sobrante de otra sucursal) vs COMPRA real.
          trx.raw(`ROUND(SUM(LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock))) * ${cost}), 2) AS traspasable_valor`),
          trx.raw(`ROUND(SUM(GREATEST(0, GREATEST(0, ${target} - ${oh} - ${it}) - LEAST(GREATEST(0, ${target} - ${oh} - ${it}), GREATEST(0, COALESCE(sbp.surplus_total,0) - GREATEST(0, ${oh} - rp.max_stock)))) * ${cost}), 2) AS compra_real_valor`),
          // RA-PRO.15 — VALOR del punto de abasto (Σ umbral × costo/caja) + existencia actual, según el filtro.
          trx.raw(`ROUND(SUM(rp.min_stock * ${cost}), 2) AS min_valor`),
          trx.raw(`ROUND(SUM(rp.reorder_point * ${cost}), 2) AS reorden_valor`),
          trx.raw(`ROUND(SUM(rp.max_stock * ${cost}), 2) AS max_valor`),
          trx.raw(`ROUND(SUM(${oh} * ${cost}), 2) AS existencia_valor`),
          trx.raw(`ROUND(SUM(rp.min_stock / (${cf})), 2) AS min_cajas`),
          trx.raw(`ROUND(SUM(rp.reorder_point / (${cf})), 2) AS reorden_cajas`),
          trx.raw(`ROUND(SUM(rp.max_stock / (${cf})), 2) AS max_cajas`),
          trx.raw(`ROUND(SUM(${oh} / (${cf})), 2) AS existencia_cajas`),
        ).first();
      return r;
    });
  }

  // ── RA-PRO.17 — Compra sugerida (ritmo de compra REAL) ────────────────
  /**
   * Compra sugerida DEMAND-DRIVEN: la VENTA REAL de la red fija el reorden (RA-PRO.17).
   *
   *   sugerido = max(0, venta_diaria_red × cobertura − existencia_red − en_tránsito)   [en cajas]
   *   valor    = sugerido × costo_real (del ledger de compras, ponderado)
   *
   * Evolución: primero se ancló en el RITMO DE COMPRA real (entrada X-A-40) para VALIDAR contra el
   * gasto mensual real — pero eso sobre-sugería lo sobrestockeado (compraba lo que ya no rota). La
   * demanda es la señal correcta: si la existencia ya cubre el horizonte → sugerido 0. El ledger de
   * compras (analytics.purchase_velocity) se conserva solo para el COSTO REAL y el almacén de compra.
   *
   * Grano = PRODUCTO (red): el pedido a proveedor es total por producto (entra al hub y se distribuye);
   * agregarlo evita doble-conteo cuando un producto se compra en 2 hubs. Unidades: venta/existencia
   * (kdil) en PIEZAS → /uxc (factor_sale o box_size); en_tránsito (OC) ya en cajas. `piezas` = cajas × uxc.
   */
  async purchaseSuggestion(q: PurchaseSuggestionQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const covReq = Number(q.coverage_days) > 0 ? Math.min(120, Math.max(1, Number(q.coverage_days))) : null;
    const page = Math.max(1, Number(q.page) || 1);
    const cap = q.export ? 100000 : 500;
    const pageSize = Math.min(cap, Math.max(1, Number(q.pageSize) || (q.export ? cap : 50)));
    return this.tk.run(async (trx) => {
      // RA-PRO.27 — parámetros globales del pedido (fill rate + cobertura) configurables por tenant.
      // Degrada a defaults + sin columnas de override si la migración aún no aplicó (no 500).
      const ready = await this.personalizationReady(trx);
      const st: any = ready ? await trx('commercial.replenishment_settings').where({ tenant_id: tenantId }).first() : this.DEFAULT_SETTINGS;
      const colFill = ready ? 'sup.fill_rate_override' : 'NULL::numeric';
      const colSafety = ready ? 'sup.safety_pct' : 'NULL::numeric';
      const colCov = ready ? 'sup.coverage_days_override' : 'NULL::int';
      const cov = covReq ?? Math.min(120, Math.max(1, Number(st?.default_coverage_days) || 30));
      const fwin = Math.max(30, Number(st?.fill_window_days) || 180);   // ventana de historia del fill rate
      const fmin = Math.max(1, Number(st?.fill_min_lines) || 3);        // mínimo de recepciones para confiar
      const maxinf = Math.min(3, Math.max(1, Number(st?.fill_max_inflate) || 1.30)); // tope de inflado
      // RA-PRO.31 — LEE del fact precomputado (analytics.replenishment_plan) agregado a grano RED
      // (o por sucursal si hay filtro de almacén). suf/bf/caja_cost/price_ratio/unit_source ya vienen
      // resueltos por producto; demanda/existencia/tránsito/revenue se SUMAN sobre los almacenes del scope.
      const SUF = 'COALESCE(plan.suf, 1)';
      const BF = 'COALESCE(plan.bf, 1)';
      const sellDayPz = 'COALESCE(plan.sell_day_pz, 0)';   // venta diaria (red o sucursal) en piezas
      const stockPz = 'COALESCE(plan.stock_pz, 0)';         // existencia (unidades de stock)
      const transit = 'COALESCE(plan.transit, 0)';          // OC en tránsito (cajas) — lo que se MUESTRA
      // RA-PRO.45 — lo que se DESCUENTA: las mismas cajas pesadas por P(llega | edad de la OC).
      // No todo lo que está en papel llega: en Kepler la OC se captura al recibir, así que una que
      // sigue abierta hace 45 días sólo se materializa el 13.6% de las veces.
      const transitEff = 'COALESCE(plan.transit_eff, plan.transit, 0)';
      // costo real POR CAJA — en el fact ya = costE(unidad de stock) × BF. La DEMANDA manda el reorden:
      // objetivo = venta_diaria × cobertura; sugerido = objetivo − existencia − tránsito (0 si ya cubre).
      const costCaja = 'COALESCE(plan.caja_cost, 0)';
      // RA-PRO.27 — FILL RATE PERSONALIZADO. Infla el sugerido para compensar surtido incompleto.
      // Precedencia: override manual del proveedor → historia SKU×proveedor → historia proveedor →
      // 100% (sin historia). El fill rate se toma de OCs recibidas/parciales en la ventana (fwin);
      // requiere ≥ fmin líneas para confiar; el inflado se topa en maxinf (piso del fill = 1/maxinf).
      // AUTOMÁTICO BAJO ANÁLISIS: cobertura y colchón se derivan de datos, sin captura manual.
      //   auto cobertura = cadencia real de compra (OCs recibidas en la ventana) + lead time.
      //   auto colchón%  = variabilidad de demanda (CV de reorder_policy): estable 0 / medio 10 / volátil 20.
      // Precedencia (ambos): override manual del proveedor → valor auto del análisis → global.
      const autoCov = `CASE WHEN scad.recs >= 2 AND scad.cadence > 0 THEN ceil(scad.cadence + COALESCE(sup.lead_time_days, 7)) END`;
      const autoSafety = `CASE WHEN scv.cv >= 1.0 THEN 20 WHEN scv.cv >= 0.5 THEN 10 ELSE 0 END`;
      // RA-PRO.41 — TODO AUTOMÁTICO desde históricos (fact):
      //   cobertura: manual → cadencia Kepler real del producto + lead time derivado del ODS → cadencia
      //              de nuestras POs → knob global. lead_days trae fallback global (~4d) desde el fact.
      //   colchón:   manual → cuantiles por clase (plan.safety_pct_q, robusto a intermitencia) → CV → 0.
      //   estación:  la demanda del horizonte se multiplica por season_ratio (idx próximos 30d ÷ idx
      //              últimos 30d, jerárquico y con banda muerta) — el trailing ya trae la estación del
      //              mes que pasó, la razón la corrige (backtest: bias enero +39.6% → −4.7%).
      const autoCovKepler = `CASE WHEN plan.order_days BETWEEN 1 AND 90
                                  THEN LEAST(120, GREATEST(7, ceil(plan.order_days + COALESCE(plan.lead_days, 4)))) END`;
      const seasonR = `COALESCE(plan.season_ratio, 1)`;
      const covEff = `COALESCE(${colCov}, ${autoCovKepler}, ${autoCov}, :cov)`;
      const safetyEff = `COALESCE(${colSafety}, plan.safety_pct_q * 100, ${autoSafety}, 0)`;
      const frSku = `CASE WHEN COALESCE(frp.n,0) >= :fmin AND COALESCE(frp.ord,0) > 0 THEN LEAST(1.0, frp.recv::numeric / frp.ord) END`;
      const frSup = `CASE WHEN COALESCE(frs.n,0) >= :fmin AND COALESCE(frs.ord,0) > 0 THEN LEAST(1.0, frs.recv::numeric / frs.ord) END`;
      const fillRate = `COALESCE(${colFill}, ${frSku}, ${frSup}, 1.0)`;
      const fillSource = `CASE WHEN ${colFill} IS NOT NULL THEN 'override' WHEN ${frSku} IS NOT NULL THEN 'sku' WHEN ${frSup} IS NOT NULL THEN 'supplier' ELSE 'default' END`;
      const covSource = `CASE WHEN ${colCov} IS NOT NULL THEN 'manual' WHEN ${autoCovKepler} IS NOT NULL THEN 'kepler' WHEN ${autoCov} IS NOT NULL THEN 'auto' ELSE 'global' END`;
      const safetySource = `CASE WHEN ${colSafety} IS NOT NULL THEN 'manual' WHEN plan.safety_pct_q IS NOT NULL THEN 'quantil' WHEN ${autoSafety} > 0 THEN 'auto' ELSE 'none' END`;
      // sugerido = (necesidad ÷ fill, tope inflado) × (1 + colchón% efectivo)
      const fillFactor = `(1.0 / GREATEST(${fillRate}, 1.0 / :maxinf)) * (1 + ${safetyEff}/100.0)`;
      // En CAJAS: demanda (sub-unidades, × estación) ÷ SUF ÷ BF; existencia ÷ BF; tránsito ya en cajas.
      const needBase = `GREATEST(0, ${sellDayPz} * ${seasonR} * ${covEff} / (${SUF} * ${BF}) - ${stockPz} / ${BF} - ${transitEff})`; // necesidad neta (sin fill)
      const sug = `(${needBase} * ${fillFactor})`;                                                          // sugerido personalizado
      const filters: string[] = ['pr.tenant_id = :t', 'pr.activo = true', 'pr.deleted_at IS NULL'];
      const binds: Record<string, unknown> = { t: tenantId, cov, fwin, fmin, maxinf };
      // Almacén: seleccionar almacén en Comprar = PEDIDO PER-SUCURSAL (demanda + existencia de
      // ESE almacén), NO "productos comprados ahí". Los proveedores DIRECTOS a sucursal (Ferrero)
      // no tienen fila en el ledger de compras del almacén → con el filtro viejo (pl.product_id IS
      // NOT NULL) el pedido de una sucursal salía VACÍO. El ledger (pl) queda a nivel RED solo para
      // el costo real y el almacén primario; el scope por almacén va sobre demanda/existencia/tránsito.
      const whIds = this.whIds(q);
      binds.selwh = whIds.length === 1 ? whIds[0] : null; // "Compra en" = la sucursal filtrada
      let planWh = ''; // scope por almacén sobre el fact (demanda/existencia/tránsito por sucursal)
      if (whIds.length) {
        const inList = whIds.map((_, i) => `:w${i}`).join(',');
        whIds.forEach((w, i) => { binds[`w${i}`] = w; });
        planWh = ` AND warehouse_id IN (${inList})`;
      }
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) { filters.push('pr.supplier_id = :sid'); binds.sid = q.supplier_id; }
      if (q.brand_id && UUID_RX.test(q.brand_id)) { filters.push('pr.brand_id = :bid'); binds.bid = q.brand_id; }
      if (q.category_id && UUID_RX.test(q.category_id)) { filters.push('pr.category_id = :cat'); binds.cat = q.category_id; }
      if (q.search && q.search.trim()) { filters.push('(pr.sku ILIKE :s OR pr.nombre ILIKE :s)'); binds.s = `%${q.search.trim()}%`; }
      // RA-PRO.23 — no listar los SKUs ALIAS (in-and-out); su demanda/existencia/velocidad
      // se pliega en el canónico (abajo, vía commercial.product_aliases).
      filters.push('NOT EXISTS (SELECT 1 FROM commercial.product_aliases pa WHERE pa.tenant_id = :t AND pa.alias_product_id = pr.id AND pa.deleted_at IS NULL)');
      // Bucket por COBERTURA (días que aguanta la red vendiendo): agotado / crítico(<7) / bajo(<cobertura) /
      // sano / sobrestock(>90). DEFAULT = TODOS los productos (visibilidad total); scope='needed' o un
      // bucket lo acotan. Ordenado por valor del sugerido → lo accionable arriba, lo cubierto abajo.
      const cover = `(${stockPz} * ${SUF} / NULLIF(${sellDayPz}, 0))`; // días: existencia(stock) ÷ demanda diaria en unidades de stock (sellDayPz/SUF)
      const bucketExpr = `CASE WHEN ${stockPz} <= 0 AND ${sellDayPz} <= 0 THEN 'sin_dato' WHEN ${stockPz} <= 0 THEN 'agotado' WHEN ${cover} < 7 THEN 'critico' WHEN ${cover} < ${covEff} THEN 'bajo' WHEN ${cover} > 90 THEN 'sobrestock' ELSE 'sano' END`;
      if (q.bucket && ['agotado', 'critico', 'bajo', 'sano', 'sobrestock', 'sin_dato'].includes(q.bucket)) { filters.push(`${bucketExpr} = :bkt`); binds.bkt = q.bucket; }
      else if (q.scope === 'needed') { filters.push(`${sug} > 0`); }
      const where = filters.join(' AND ');

      // ANCLA = TODO EL CATÁLOGO (activo): así se ven TODOS los productos (scope=all), no solo los que
      // necesitan pedido. RA-PRO.31: las primitivas pesadas (demanda/existencia/tránsito/econ/ratio/costo)
      // vienen del FACT precomputado agregado a grano producto (o por sucursal si hay filtro de almacén);
      // el ledger, el fill rate y la cadencia (frs/frp/scv/scad, joins chicos a nivel proveedor) van live.
      const from = `
        FROM catalog.products pr
        LEFT JOIN (
          SELECT product_id,
                 sum(daily_pieces) AS sell_day_pz, sum(stock_pz) AS stock_pz, sum(transit_cajas) AS transit,
                 sum(transit_eff_cajas) AS transit_eff,
                 sum(revenue30) AS rev30,
                 max(suf) AS suf, max(bf) AS bf, max(caja_cost) AS caja_cost,
                 max(price_ratio) AS price_ratio, max(unit_source) AS unit_source,
                 max(buy_rate) AS buy_rate, max(order_days) AS order_days, max(last_purchase) AS last_purchase,
                 min(primary_wh::text)::uuid AS primary_wh,
                 -- RA-PRO.41 — señales derivadas (grano producto: idénticas en todas las filas)
                 max(season_ratio) AS season_ratio, max(season_src) AS season_src,
                 max(safety_pct_q) AS safety_pct_q, max(lead_days) AS lead_days
            FROM analytics.replenishment_plan
           WHERE tenant_id = :t${planWh}
           GROUP BY product_id
        ) plan ON plan.product_id = pr.id
        LEFT JOIN catalog.suppliers sup ON sup.tenant_id = :t AND sup.id = pr.supplier_id
        LEFT JOIN (
          SELECT po.supplier_id, SUM(pol.received_qty) AS recv, SUM(pol.ordered_qty) AS ord, COUNT(*) AS n
            FROM commercial.purchase_orders po
            JOIN commercial.purchase_order_lines pol ON pol.tenant_id = po.tenant_id AND pol.purchase_order_id = po.id
           WHERE po.tenant_id = :t AND po.source_type = 'supplier' AND po.estado IN ('received','partial')
             AND po.supplier_id IS NOT NULL
             AND COALESCE(po.closed_at, po.created_at) >= now() - make_interval(days => :fwin::int)
           GROUP BY po.supplier_id
        ) frs ON frs.supplier_id = pr.supplier_id
        LEFT JOIN (
          SELECT po.supplier_id, pol.product_id, SUM(pol.received_qty) AS recv, SUM(pol.ordered_qty) AS ord, COUNT(*) AS n
            FROM commercial.purchase_orders po
            JOIN commercial.purchase_order_lines pol ON pol.tenant_id = po.tenant_id AND pol.purchase_order_id = po.id
           WHERE po.tenant_id = :t AND po.source_type = 'supplier' AND po.estado IN ('received','partial')
             AND po.supplier_id IS NOT NULL
             AND COALESCE(po.closed_at, po.created_at) >= now() - make_interval(days => :fwin::int)
           GROUP BY po.supplier_id, pol.product_id
        ) frp ON frp.supplier_id = pr.supplier_id AND frp.product_id = pr.id
        LEFT JOIN (
          SELECT p.supplier_id, avg(rp.demand_cv) AS cv
            FROM catalog.products p
            JOIN commercial.reorder_policy rp ON rp.tenant_id = p.tenant_id AND rp.product_id = p.id
           WHERE p.tenant_id = :t AND p.supplier_id IS NOT NULL AND rp.demand_cv IS NOT NULL
           GROUP BY p.supplier_id
        ) scv ON scv.supplier_id = pr.supplier_id
        LEFT JOIN (
          SELECT po.supplier_id,
                 (max(po.closed_at::date) - min(po.closed_at::date))::numeric / NULLIF(count(*) - 1, 0) AS cadence,
                 count(*) AS recs
            FROM commercial.purchase_orders po
           WHERE po.tenant_id = :t AND po.source_type = 'supplier' AND po.estado IN ('received','partial')
             AND po.closed_at IS NOT NULL AND po.closed_at >= now() - make_interval(days => :fwin::int)
           GROUP BY po.supplier_id
        ) scad ON scad.supplier_id = pr.supplier_id
        LEFT JOIN commercial.warehouses w ON w.tenant_id = :t AND w.id = COALESCE(:selwh::uuid, plan.primary_wh)
        WHERE ${where}`;

      // RA-PRO.18 — ranking (#) y ABC de RED se calculan como WINDOWS sobre TODO el universo
      // filtrado (no la página): rank por venta $ 30d; ABC = Pareto por venta $ (A≤80% acum,
      // B≤95%, C resto). Capa interna = todas las columnas + rev30; capa externa pagina.
      // PERF: los totales (count/needed/valor/revenue) también salen como WINDOWS aquí en la
      // MISMA pasada — antes se ejecutaba el `from` pesado (con sus 4 subagregados) 2 veces.
      const rows = (await trx.raw(`
        SELECT z.*,
               COUNT(*) OVER() AS _total,
               COUNT(*) FILTER (WHERE z.suggested_units > 0) OVER() AS _needed,
               ROUND(SUM(z.suggested_cost) OVER()::numeric, 2) AS _total_valor,
               ROUND(SUM(z.sell_month_mxn) OVER()::numeric, 2) AS _total_revenue,
               RANK() OVER (ORDER BY z.sell_month_mxn DESC NULLS LAST) AS sales_rank,
               CASE
                 WHEN COALESCE(SUM(z.sell_month_mxn) OVER (), 0) = 0 THEN 'C'
                 WHEN SUM(z.sell_month_mxn) OVER (ORDER BY z.sell_month_mxn DESC ROWS UNBOUNDED PRECEDING)
                      / NULLIF(SUM(z.sell_month_mxn) OVER (), 0) <= 0.80 THEN 'A'
                 WHEN SUM(z.sell_month_mxn) OVER (ORDER BY z.sell_month_mxn DESC ROWS UNBOUNDED PRECEDING)
                      / NULLIF(SUM(z.sell_month_mxn) OVER (), 0) <= 0.95 THEN 'B'
                 ELSE 'C' END AS abc_class
        FROM (
          SELECT pr.id AS product_id, COALESCE(:selwh::uuid, plan.primary_wh) AS warehouse_id, w.code AS warehouse_code,
                 pr.sku, pr.nombre, sup.id AS supplier_id, sup.name AS supplier_name,
                 ${BF} AS uxc,
                 round((${SUF})::numeric, 2) AS stock_unit_factor,
                 round(COALESCE(plan.price_ratio, 0)::numeric, 1) AS price_ratio,
                 COALESCE(plan.unit_source, 'catalog') AS unit_source,
                 round(COALESCE(plan.buy_rate,0)::numeric, 3) AS daily_rate,
                 plan.order_days, plan.last_purchase,
                 round((${stockPz} / ${BF})::numeric, 1) AS on_hand_pieces,
                 round((${stockPz} / ${BF})::numeric, 2) AS on_hand_units,
                 ${transit} AS in_transit_units,
                 round((${costCaja})::numeric, 4) AS unit_cost,
                 round((${sellDayPz} * ${seasonR} * ${covEff} / (${SUF} * ${BF}))::numeric, 2) AS target_units,
                 round((${seasonR})::numeric, 3) AS season_ratio,
                 plan.season_src,
                 round(${sug}::numeric, 2) AS suggested_units,
                 round(${needBase}::numeric, 2) AS base_units,
                 round((${fillRate})::numeric, 3) AS fill_rate,
                 ${fillSource} AS fill_source,
                 ${covEff} AS coverage_days_eff,
                 ${covSource} AS coverage_source,
                 round((${safetyEff})::numeric, 0) AS safety_pct_eff,
                 ${safetySource} AS safety_source,
                 round((${sug} * ${BF})::numeric, 0) AS suggested_pieces,
                 round((${sug} * ${costCaja})::numeric, 2) AS suggested_cost,
                 round((${sellDayPz} / (${SUF} * ${BF}))::numeric, 2) AS sell_daily_cajas,
                 round((${sellDayPz} * 30 / (${SUF} * ${BF}))::numeric, 0) AS sell_month_cajas,
                 round(COALESCE(plan.rev30,0)::numeric, 2) AS sell_month_mxn,
                 round((${stockPz} * ${SUF} / NULLIF(${sellDayPz}, 0))::numeric, 0) AS days_cover,
                 ${bucketExpr} AS bucket
          ${from}
        ) z
        ORDER BY z.suggested_cost DESC, z.sell_month_mxn DESC, z.on_hand_pieces DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, binds)).rows;

      const agg: any = rows[0] || {};
      return {
        total: Number(agg._total || 0),
        needed: Number(agg._needed || 0),
        total_valor: Number(agg._total_valor || 0),
        total_revenue: Number(agg._total_revenue || 0),
        page, pageSize, coverage_days: cov, rows,
      };
    });
  }

  // ── RA-PRO.32 — Réplica del workbook del comprador (Excel) ────────────
  /**
   * Una fila por SKU con las columnas del Excel de compra: UXC (factor de caja), costo/caja,
   * y por cada PUNTO DE COMPRA territorial (PH `MD-10` / Morelia `MD-30`+`MD-32` / Zamora Canindo `06`)
   * su Venta 30d (cajas), Existencia (cajas) y Pedido sugerido (cajas); CEDIS `MD-CEDIS` solo
   * existencia; más $Pedido, Valor Venta y Valor Existencia. Lee del fact precomputado
   * (analytics.replenishment_plan) y pivotea por CÓDIGO de almacén — no depende de la topología.
   *
   *   pedido(territorio) = max(0, venta_diaria × cobertura − existencia − tránsito)   [cajas]
   */
  async workbook(q: WorkbookQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const cov = Math.min(120, Math.max(1, Number(q.coverage_days) || 30));
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = q.export ? 100000 : Math.min(1000, Math.max(1, Number(q.pageSize) || 100));
    const offset = (page - 1) * pageSize;
    return this.tk.run(async (trx) => {
      const binds: Record<string, unknown> = { t: tenantId, cov };
      const filters = ['pr.tenant_id = :t', 'pr.activo = true', 'pr.deleted_at IS NULL',
        'NOT EXISTS (SELECT 1 FROM commercial.product_aliases pa WHERE pa.tenant_id = :t AND pa.alias_product_id = pr.id AND pa.deleted_at IS NULL)'];
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) { filters.push('pr.supplier_id = :sid'); binds.sid = q.supplier_id; }
      if (q.brand_id && UUID_RX.test(q.brand_id)) { filters.push('pr.brand_id = :bid'); binds.bid = q.brand_id; }
      if (q.category_id && UUID_RX.test(q.category_id)) { filters.push('pr.category_id = :cat'); binds.cat = q.category_id; }
      if (q.search && q.search.trim()) { filters.push('(pr.sku ILIKE :s OR pr.nombre ILIKE :s)'); binds.s = `%${q.search.trim()}%`; }
      const where = filters.join(' AND ');

      // Columnas = SUCURSAL (branch) o una sola GENERAL (red), a elección del usuario. Territorio = el
      // almacén MISMO (NO se colapsa a raíz — eso sobre-agrupaba todo a CEDIS en prod). Selección de
      // sucursales por warehouse_ids (una/varias); sin selección = todas las que sostienen inventario
      // (excluye rutas/vehículos/almacenes de conteo). Cero códigos hardcodeados; columnas dinámicas.
      const general = q.group === 'general';
      const whIds = (q.warehouse_ids ?? '').split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
      let whFilter = '';
      if (whIds.length) {
        const inList = whIds.map((_, i) => `:wh${i}`).join(',');
        whIds.forEach((w, i) => { binds[`wh${i}`] = w; });
        whFilter = ` AND rp.warehouse_id IN (${inList})`;
      }
      // Sin selección explícita: en modo POR SUCURSAL sólo almacenes que sostienen inventario
      // (evita columnas basura de rutas/vehículos sin stock). En modo GENERAL NO se filtra por
      // stock: es un único agregado de red y debe incluir TODA la venta, incluidas las camionetas
      // (kind='truck', autoventa) que venden con stock 0 — si no, la venta General queda corta.
      const stockJoin = (whIds.length || general) ? '' : `JOIN (
            SELECT warehouse_id FROM analytics.replenishment_plan WHERE tenant_id = :t GROUP BY warehouse_id HAVING SUM(stock_pz) > 0
          ) sw ON sw.warehouse_id = rp.warehouse_id`;
      const colExpr = general ? `'GENERAL'` : 'w.code';
      const SUF = 'COALESCE(max(b.suf),1)';
      const BF = 'COALESCE(max(b.bf),1)';
      // RA-PRO.36.2 — filtros de PRODUCTO server-side (aplican sobre TODO el dataset, antes de paginar):
      // scope (con pedido) + tendencia IAD + sobrestock. Sin esto, los chips filtrarían solo la página cargada.
      const wbConds: string[] = [];
      if (q.scope === 'needed') wbConds.push('p.suma_pedido_cajas > 0');
      if (q.iad === 'accel') wbConds.push('da.iad >= 0.25');
      else if (q.iad === 'decel') wbConds.push('da.iad <= -0.25');
      if (q.only_overstock) wbConds.push('p.has_over');
      const wbWhere = wbConds.length ? `WHERE ${wbConds.join(' AND ')}` : '';
      const inner = `
        WITH base AS (
          SELECT pr.id AS product_id, pr.sku, pr.nombre, pr.supplier_id,
                 rp.suf, rp.bf, rp.caja_cost, rp.daily_pieces, rp.stock_pz, rp.transit_cajas,
                 COALESCE(rp.transit_eff_cajas, rp.transit_cajas) AS transit_eff_cajas, rp.revenue30,
                 -- RA — política de reorden por (producto, almacén). reorder_point/max_stock en PIEZAS
                 -- (misma unidad que stock_pz → se dividen por BF para cajas, como la columna Exist).
                 rop.reorder_point AS rop_reorder, rop.max_stock AS rop_max, rop.xyz_class AS rop_xyz,
                 rp.season_ratio, rp.season_src,
                 -- RA-PRO.46 — el rótulo de la unidad base LO DICE KEPLER (kdii.c11 vía la vista
                 -- derivada del ODS); antes la pantalla escribía "pz" a mano y mentía en los
                 -- productos a granel (el azúcar 99029 se mide en 500 g, no en piezas).
                 lad.u1_label AS unidad_base,
                 ${colExpr} AS col_code
            FROM catalog.products pr
            JOIN analytics.replenishment_plan rp ON rp.tenant_id = pr.tenant_id AND rp.product_id = pr.id
            JOIN commercial.warehouses w ON w.tenant_id = :t AND w.id = rp.warehouse_id
            LEFT JOIN commercial.reorder_policy rop ON rop.tenant_id = pr.tenant_id AND rop.product_id = pr.id AND rop.warehouse_id = rp.warehouse_id
            LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = pr.sku
            ${stockJoin}
           WHERE ${where}${whFilter}
             AND (rp.stock_pz > 0 OR rp.daily_pieces > 0 OR rp.transit_cajas > 0)
        ),
        per AS (
          SELECT b.product_id, b.sku, b.nombre, b.supplier_id, b.col_code,
                 ${BF} AS bf, round(COALESCE(max(b.caja_cost),0)::numeric, 2) AS caja_cost,
                 round((COALESCE(sum(b.daily_pieces),0) * 30 / (${SUF} * ${BF}))::numeric, 1) AS vta,
                 round((COALESCE(sum(b.stock_pz),0) / ${BF})::numeric, 1) AS exis,
                 -- RA-PRO.41 — la demanda del horizonte lleva la estación (razón desestacionalizada).
                 round(GREATEST(0, COALESCE(sum(b.daily_pieces),0) * COALESCE(max(b.season_ratio),1) * :cov / (${SUF} * ${BF}) - COALESCE(sum(b.stock_pz),0) / ${BF} - COALESCE(sum(b.transit_eff_cajas),0))::numeric, 1) AS ped,
                 -- tran es el CRUDO a propósito: es lo que ve el comprador y lo que tiene que
                 -- cuadrar con los folios del diálogo "En camino". Descontar usa el pesado (arriba).
                 round(COALESCE(sum(b.transit_cajas),0)::numeric, 1) AS tran,
                 COALESCE(sum(b.revenue30),0) AS rev, COALESCE(sum(b.stock_pz),0) AS stock_pz,
                 COALESCE(sum(b.rop_reorder),0) AS reorder_pz, COALESCE(sum(b.rop_max),0) AS max_pz, max(b.rop_xyz) AS xyz,
                 max(b.season_ratio) AS season_ratio, max(b.season_src) AS season_src,
                 max(b.unidad_base) AS unidad_base
            FROM base b
           GROUP BY b.product_id, b.sku, b.nombre, b.supplier_id, b.col_code
        ),
        prod AS (
          SELECT product_id, sku, nombre, supplier_id,
                 max(bf) AS uxc, round(max(caja_cost)::numeric, 2) AS caja_cost,
                 max(unidad_base) AS unidad_base,
                 jsonb_object_agg(col_code, jsonb_build_object('vta', vta, 'exis', exis, 'ped', ped, 'tran', tran)) AS cells,
                 round(sum(tran)::numeric, 1) AS transito_cajas,   -- RA-PRO.44: explica el "Pedido 0"
                 -- Reorden/Máximo de RED en cajas (Σ piezas de las sucursales ÷ BF) + XYZ peor-caso.
                 round((sum(reorder_pz) / NULLIF(max(bf),0))::numeric, 1) AS reorder_cajas,
                 round((sum(max_pz) / NULLIF(max(bf),0))::numeric, 1) AS max_cajas,
                 max(xyz) AS xyz_class,
                 round(max(season_ratio)::numeric, 3) AS season_ratio, max(season_src) AS season_src,
                 round(sum(ped)::numeric, 1) AS suma_pedido_cajas,
                 round(sum(ped * caja_cost)::numeric, 2) AS pedido_valor,
                 round(sum(rev)::numeric, 2) AS valor_venta,
                 round((sum(stock_pz) / max(bf) * max(caja_cost))::numeric, 2) AS valor_exis,
                 bool_or(exis > 0 AND (vta <= 0 OR exis * 30.0 / NULLIF(vta, 0) > 90)) AS has_over
            FROM per
           GROUP BY product_id, sku, nombre, supplier_id
        )
        SELECT p.*, sup.name AS supplier_name,
               lp.box_size, lp.pack_size,
               CASE WHEN lp.box_size > 1 AND lp.pack_size > 1 AND lp.box_size % lp.pack_size = 0
                    THEN (lp.box_size / lp.pack_size) ELSE NULL END AS packs_per_box,
               da.iad, da.band AS iad_band, da.status AS iad_status,
               da.z_short AS iad_z_short, da.z_seasonal AS iad_z_seasonal, da.has_seasonal AS iad_has_seasonal
          FROM prod p
          LEFT JOIN catalog.suppliers sup ON sup.tenant_id = :t AND sup.id = p.supplier_id
          LEFT JOIN (SELECT product_id, max(box_size) box_size, max(pack_size) pack_size
                       FROM commercial.product_label_prices WHERE tenant_id = :t GROUP BY product_id) lp
            ON lp.product_id = p.product_id
          LEFT JOIN analytics.demand_acceleration da ON da.tenant_id = :t AND da.product_id = p.product_id
         ${wbWhere}`;

      const rows = (await trx.raw(`${inner} ORDER BY valor_venta DESC NULLS LAST, sku LIMIT ${pageSize} OFFSET ${offset}`, binds)).rows;
      const tot = (await trx.raw(`SELECT count(*)::int c, round(SUM(pedido_valor)::numeric,2) total_pedido, round(SUM(valor_venta)::numeric,2) total_venta, round(SUM(valor_exis)::numeric,2) total_exis FROM (${inner}) z`, binds)).rows[0];
      // Columnas presentes → dinámicas. General = 1 columna; por sucursal = 1 almacén por columna.
      const territories = general
        ? [{ code: 'GENERAL', name: 'General (red)' }]
        : (await trx.raw(`
            SELECT w.code, max(w.name) AS name
              FROM catalog.products pr
              JOIN analytics.replenishment_plan rp ON rp.tenant_id = pr.tenant_id AND rp.product_id = pr.id
              JOIN commercial.warehouses w ON w.tenant_id = :t AND w.id = rp.warehouse_id
              ${stockJoin}
             WHERE ${where}${whFilter} AND (rp.stock_pz > 0 OR rp.daily_pieces > 0 OR rp.transit_cajas > 0)
             GROUP BY w.code
             ORDER BY SUM(rp.revenue30) DESC NULLS LAST, SUM(rp.stock_pz) DESC`, binds)).rows
            .map((t: { code: string; name: string }) => ({ code: t.code, name: t.name }));

      return {
        total: Number(tot?.c || 0),
        page, pageSize, coverage_days: cov,
        territories,
        totals: {
          pedido: Number(tot?.total_pedido || 0),
          venta: Number(tot?.total_venta || 0),
          exis: Number(tot?.total_exis || 0),
        },
        rows,
      };
    });
  }

  /**
   * RA-PRO.32 — Detalle (drill-down) de un SKU de la Vista Excel: economía del producto +
   * desglose POR ALMACÉN (con su punto de compra/raíz resuelto por topología, sin hardcodear códigos).
   */
  /**
   * RA-PRO.44 — QUÉ VIENE EN CAMINO de un SKU, con folio y fecha. Es la explicación del "Pedido 0":
   * cuando el motor no pide es casi siempre porque hay OC abierta, y hasta ahora eso era invisible
   * (el comprador veía un cero sin causa). Lee el ODS en vivo — mismo criterio que el CTE `tr` del
   * fact: OC `X-A-35` sin orden de entrada `X-A-40` aguas abajo vía su vale `X-A-37`.
   *
   * `llega_aprox` = fecha de la OC + lead time del proveedor (mediana derivada del ODS, RA-PRO.41).
   * Es una ESTIMACIÓN: Kepler no registra fecha prometida (captura la cadena de un jalón), así que
   * se marca `estimada: true` — no inventamos precisión que el ERP no tiene.
   */
  async inTransitDetail(productId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(productId)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) => {
      const hasOds = (await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0]?.t;
      const prod = (await trx('catalog.products').where({ tenant_id: tenantId, id: productId })
        .first('sku', 'nombre')) as { sku: string; nombre: string } | undefined;
      if (!hasOds || !prod) return { product: prod ?? null, rows: [], total_cajas: 0, total_valor: 0 };

      // El factor de caja y el costo salen del fact (misma fuente que el pedido) → las cantidades
      // que ve el comprador acá cuadran con la columna "En camino" de la matriz.
      const econ = (await trx.raw(
        `SELECT max(bf) AS bf, max(caja_cost) AS caja_cost, max(lead_days) AS lead_days,
                sum(transit_cajas) AS tr, sum(COALESCE(transit_eff_cajas, transit_cajas)) AS tr_eff
           FROM analytics.replenishment_plan WHERE tenant_id = ? AND product_id = ?`,
        [tenantId, productId])).rows[0] || {};
      const bf = Number(econ.bf) || 1;
      const cajaCost = Number(econ.caja_cost) || 0;
      const lead = Number(econ.lead_days) || 4;

      // RA-PRO.45.1 — lee la capa normalizada (`analytics.erp_purchase_orders` / `_doc_lines`),
      // no `kdm1` crudo: el decode de "OC abierta" y del empaque declarado vive en la vista.
      const rows = (await trx.raw(`
        SELECT oc.folio,
               oc.sucursal,
               oc.doc_date                         AS fecha_oc,
               (oc.doc_date + (?::numeric)::int)   AS llega_aprox,
               oc.dias_abierta,
               oc.proveedor_nombre                 AS proveedor,
               l.unidad,
               sum(l.cantidad)                     AS cantidad,
               round(sum(CASE
                     WHEN l.unidades_por_caja > 0 AND l.costo_caja > 0 AND ?::numeric > 0
                          AND abs(l.costo_caja - ?::numeric) <= 0.15 * (?::numeric)
                       THEN l.cantidad / l.unidades_por_caja
                     ELSE l.cantidad / (?::numeric) END)::numeric, 1) AS cajas
          FROM analytics.erp_purchase_orders oc
          JOIN analytics.erp_purchase_doc_lines l
            ON l.doctype='XA3501' AND l.sucursal=oc.sucursal AND l.folio=oc.folio
         WHERE oc.doc_date >= CURRENT_DATE - 120
           AND NOT oc.cerrada
           AND oc.estatus NOT IN ('F', 'C', 'R')   -- mismo criterio que el fact (RA-PRO.45)
           AND l.sku = ?
         GROUP BY oc.folio, oc.sucursal, oc.doc_date, oc.dias_abierta, oc.proveedor_nombre, l.unidad
         ORDER BY oc.doc_date`,
        [lead, cajaCost, cajaCost, cajaCost, bf, prod.sku])).rows as Array<Record<string, unknown>>;

      const out = rows.map((r) => ({
        folio: String(r.folio ?? '').trim(),
        sucursal: String(r.sucursal ?? '').trim(),
        fecha_oc: r.fecha_oc,
        llega_aprox: r.llega_aprox,
        llega_estimada: true,          // Kepler no guarda fecha prometida — es OC + lead derivado
        dias_abierta: Number(r.dias_abierta) || 0,
        proveedor: (r.proveedor as string) || null,
        unidad: (r.unidad as string) || null,
        cantidad: Number(r.cantidad) || 0,
        cajas: Number(r.cajas) || 0,
        valor: Math.round((Number(r.cajas) || 0) * cajaCost * 100) / 100,
      }));
      return {
        product: { sku: prod.sku, nombre: prod.nombre },
        lead_days: lead,
        rows: out,
        total_cajas: Math.round(out.reduce((s, r) => s + r.cajas, 0) * 10) / 10,
        total_valor: Math.round(out.reduce((s, r) => s + r.valor, 0) * 100) / 100,
        // RA-PRO.45 — lo que el motor DESCUENTA de verdad: las mismas cajas pesadas por la
        // probabilidad de que cada OC llegue. La diferencia con `total_cajas` es papel que ya no
        // se va a surtir; mostrarla evita la pregunta "si vienen 180 cajas, ¿por qué pide?".
        descuenta_cajas: Math.round((Number(econ.tr_eff) || 0) * 10) / 10,
        fact_cajas: Math.round((Number(econ.tr) || 0) * 10) / 10,
      };
    });
  }

  /**
   * RA-PRO.45 — La vista INVERSA de "En camino": todas las OCs de Kepler que siguen abiertas,
   * ordenadas por antigüedad, con la probabilidad de que lleguen.
   *
   * Existe porque el motor ya dejó de creerles, pero alguien tiene que ir a cerrarlas o cancelarlas
   * en el ERP: mientras vivan, siguen ensuciando la cadena de compras. Las de +45 días llegan el
   * 13.6% de las veces — son papel abierto, no pipeline.
   *
   * La curva sale del propio ODS (misma que usa el fact); por eso esta consulta cuesta ~2 s y es una
   * pantalla de trabajo, no un widget de dashboard.
   */
  async openPurchaseOrders(q: { sucursal?: string; min_days?: number } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const minDays = Math.min(120, Math.max(0, Number(q.min_days) || 0));
    const suc = /^[0-9]{1,3}$/.test(String(q.sucursal ?? '')) ? String(q.sucursal) : null;
    return this.tk.run(async (trx) => {
      const hasOds = (await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0]?.t;
      if (!hasOds) return { rows: [], total: 0, total_valor: 0, curva: [] };

      // La curva NO se re-deriva acá: la escribe el importer del fact (un solo productor) — así la
      // probabilidad que ve el comprador es exactamente la que usó el motor para descontar.
      const curva = (await trx('analytics.oc_survival_curve')
        .where({ tenant_id: tenantId }).orderBy('edad')
        .select('edad', 'muestra', 'fallback', trx.raw('round(p*100, 1) AS pct'))) as Array<Record<string, unknown>>;

      // RA-PRO.45.1 — todo sale de `analytics.erp_purchase_orders`: el decode de "abierta" no se
      // vuelve a escribir acá. MATERIALIZED en `oc` porque la vista trae un EXISTS por fila y sin
      // la barrera el planner lo multiplica por el LATERAL de renglones.
      const rows = (await trx.raw(`
        WITH surv AS (SELECT edad, p FROM analytics.oc_survival_curve WHERE tenant_id = :t),
        oc AS MATERIALIZED (
          SELECT sucursal, folio, doc_date AS fecha_oc, proveedor_nombre AS proveedor,
                 estatus, dias_abierta AS dias
            FROM analytics.erp_purchase_orders
           WHERE doc_date >= CURRENT_DATE - 120
             AND NOT cerrada
             AND dias_abierta >= :mind
             AND (:suc::text IS NULL OR sucursal = :suc)
        )
        SELECT oc.sucursal AS almacen, oc.folio, oc.fecha_oc, oc.proveedor, oc.estatus, oc.dias,
               v.lineas, round(v.valor::numeric, 2) AS valor,
               -- El ERP manda sobre la curva: si él ya la dio por cerrada/cancelada, no llega nada.
               CASE WHEN oc.estatus IN ('F','C','R') THEN 0 ELSE round((sv.p * 100)::numeric, 1) END AS prob
          FROM oc
          -- LEFT: si el importer todavía no escribió la curva, la bandeja igual lista las OCs
          -- (con prob NULL). Una pantalla de trabajo no se queda en blanco por eso.
          LEFT JOIN surv sv ON sv.edad = (CASE WHEN oc.dias <= 3 THEN 0 WHEN oc.dias <= 7 THEN 4
                                          WHEN oc.dias <= 14 THEN 8 WHEN oc.dias <= 21 THEN 15
                                          WHEN oc.dias <= 30 THEN 22 WHEN oc.dias <= 45 THEN 31
                                          WHEN oc.dias <= 60 THEN 46 ELSE 61 END)
          JOIN LATERAL (
            SELECT count(*) AS lineas, COALESCE(sum(l.importe), 0) AS valor
              FROM analytics.erp_purchase_doc_lines l
             WHERE l.doctype='XA3501' AND l.sucursal=oc.sucursal AND l.folio=oc.folio) v ON true
         WHERE v.valor > 0
         ORDER BY oc.dias DESC, v.valor DESC
         LIMIT 500`, { t: tenantId, mind: minDays, suc })).rows as Array<Record<string, unknown>>;

      const out = rows.map((r) => ({
        almacen: String(r.almacen ?? '').trim(),
        folio: String(r.folio ?? '').trim(),
        fecha_oc: r.fecha_oc,
        proveedor: (r.proveedor as string) || null,
        estatus: String(r.estatus ?? 'N'),
        dias: Number(r.dias) || 0,
        lineas: Number(r.lineas) || 0,
        valor: Number(r.valor) || 0,
        prob: r.prob === null || r.prob === undefined ? null : Number(r.prob),
      }));
      return {
        rows: out,
        total: out.length,
        total_valor: Math.round(out.reduce((s, r) => s + r.valor, 0) * 100) / 100,
        // Lo que de verdad sigue en juego: el valor pesado por la probabilidad de que llegue.
        valor_esperado: Math.round(out.reduce((s, r) => s + r.valor * ((r.prob ?? 100) / 100), 0) * 100) / 100,
        curva: curva.map((c) => ({ edad: Number(c.edad), n: Number(c.muestra), pct: Number(c.pct), fallback: !!c.fallback })),
      };
    });
  }

  async workbookDetail(productId: string, coverageDays?: number) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(productId)) throw new BadRequestException('product_id inválido');
    const cov = Math.min(120, Math.max(1, Number(coverageDays) || 30));
    return this.tk.run(async (trx) => {
      const suf = 'COALESCE(rp.suf,1)';
      const bf = 'COALESCE(rp.bf,1)';
      const product = (await trx.raw(`
        SELECT pr.sku, pr.nombre, sup.name AS supplier_name,
               max(rp.bf) AS uxc, round(max(rp.caja_cost)::numeric, 2) AS caja_cost,
               round(max(rp.price_ratio)::numeric, 1) AS price_ratio,
               COALESCE(max(rp.unit_source), 'catalog') AS unit_source,
               round(max(rp.buy_rate)::numeric, 3) AS buy_rate,
               max(rp.last_purchase) AS last_purchase, max(rp.order_days) AS order_days
          FROM catalog.products pr
          JOIN analytics.replenishment_plan rp ON rp.tenant_id = pr.tenant_id AND rp.product_id = pr.id
          LEFT JOIN catalog.suppliers sup ON sup.tenant_id = pr.tenant_id AND sup.id = pr.supplier_id
         WHERE pr.tenant_id = :t AND pr.id = :pid
         GROUP BY pr.sku, pr.nombre, sup.name`, { t: tenantId, pid: productId })).rows[0] || null;

      const rows = (await trx.raw(`
        SELECT w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
               pr.supplier_id, round(COALESCE(rp.caja_cost, 0)::numeric, 2) AS unit_cost,
               NULL::text AS territory,
               round((rp.daily_pieces * 30 / (${suf} * ${bf}))::numeric, 1) AS venta_cajas,
               round((rp.stock_pz / ${bf})::numeric, 1) AS existencia_cajas,
               round(rp.transit_cajas::numeric, 1) AS transito_cajas,
               round(GREATEST(0, rp.daily_pieces * COALESCE(rp.season_ratio,1) * :cov / (${suf} * ${bf}) - rp.stock_pz / ${bf} - COALESCE(rp.transit_eff_cajas, rp.transit_cajas, 0))::numeric, 1) AS pedido_cajas,
               round((rp.stock_pz * ${suf} / NULLIF(rp.daily_pieces, 0))::numeric, 0) AS cover_days
          FROM analytics.replenishment_plan rp
          JOIN commercial.warehouses w ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
          JOIN catalog.products pr ON pr.tenant_id = rp.tenant_id AND pr.id = rp.product_id
         WHERE rp.tenant_id = :t AND rp.product_id = :pid
           AND (rp.stock_pz > 0 OR rp.daily_pieces > 0 OR rp.transit_cajas > 0)
         ORDER BY rp.revenue30 DESC NULLS LAST, w.code`,
        { t: tenantId, pid: productId, cov })).rows;

      return { product, coverage_days: cov, rows };
    });
  }

  // ── RA-PRO.20 — Traspaso preciso (topología-aware) ────────────────────
  /**
   * Sugiere TRASPASOS CEDIS→sucursal para cubrir el déficit de cada sucursal con el stock
   * del CEDIS que la surte (warehouses.source_warehouse_id). Grano = (producto × sucursal
   * destino). Todo por almacén (usa la demanda LIMPIA de analytics.product_demand):
   *
   *   déficit_sucursal   = max(0, venta_diaria(sucursal) × cobertura − existencia(sucursal))   [piezas]
   *   disponible_cedis   = existencia del CEDIS del producto                                    [piezas]
   *   traspaso           = déficit × min(1, disponible_cedis / Σ déficit de las sucursales)     (reparto
   *                        proporcional cuando el CEDIS no alcanza para todas)
   *   faltante (comprar) = déficit − traspaso  (lo que el CEDIS no puede cubrir → compra, RA-PRO.17)
   *
   * Unidad de salida = CAJAS (÷uxc) valuada al costo REAL de compra (purchase_velocity), igual
   * que la compra sugerida — así traspaso y compra hablan el mismo idioma. NO usa cost_with_tax ×
   * piezas (costo mixto pieza/caja → valores inflados).
   */
  async transferPlan(q: TransferSuggestionQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const cov = Math.min(120, Math.max(1, Number(q.coverage_days) || 30));
    const page = Math.max(1, Number(q.page) || 1);
    const cap = q.export ? 100000 : 500;
    const pageSize = Math.min(cap, Math.max(1, Number(q.pageSize) || (q.export ? cap : 50)));
    return this.tk.run(async (trx) => {
      const binds: Record<string, unknown> = { t: tenantId, cov };
      const filters: string[] = ['bd.transfer_pz > 0'];
      if (q.warehouse_id && UUID_RX.test(q.warehouse_id)) { filters.push('bd.wh = :dw'); binds.dw = q.warehouse_id; }
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) { filters.push('bd.supplier_id = :sid'); binds.sid = q.supplier_id; }
      if (q.category_id && UUID_RX.test(q.category_id)) { filters.push('bd.category_id = :cat'); binds.cat = q.category_id; }
      if (q.search && q.search.trim()) { filters.push('(bd.sku ILIKE :s OR bd.nombre ILIKE :s)'); binds.s = `%${q.search.trim()}%`; }
      // Marca: el fact (replenishment_plan) no trae brand_id → acotamos el universo por product_id.
      let brandScope = '';
      if (q.brand_id && UUID_RX.test(q.brand_id)) { brandScope = ' AND rp.product_id IN (SELECT id FROM catalog.products WHERE tenant_id = :t AND brand_id = :bid)'; binds.bid = q.brand_id; }
      const where = filters.join(' AND ');

      // RA-PRO.31 — LEE del fact precomputado. déficit sucursal = demanda(pieza)/suf×cov − existencia
      // (unidades de stock); avail_pz = stock del CEDIS origen (misma fila-fact del source_warehouse_id).
      // Reparto proporcional del stock del CEDIS vía window SUM (RA-PRO.29.1). suf/bf/caja_cost del fact.
      const cte = `WITH def AS (
        SELECT rp.warehouse_id AS wh, rp.source_warehouse_id AS src, rp.product_id, rp.sku, rp.nombre,
               rp.supplier_id, rp.category_id, rp.bf AS uxc, rp.caja_cost,
               GREATEST(0, rp.daily_pieces * COALESCE(rp.season_ratio,1) / rp.suf * :cov - rp.stock_pz) AS deficit_pz,  -- RA-PRO.41: el traspaso también anticipa la estación
               COALESCE(cs.stock_pz, 0) AS avail_pz
          FROM analytics.replenishment_plan rp
          LEFT JOIN analytics.replenishment_plan cs
                 ON cs.tenant_id = rp.tenant_id AND cs.warehouse_id = rp.source_warehouse_id AND cs.product_id = rp.product_id
         WHERE rp.tenant_id = :t AND rp.source_warehouse_id IS NOT NULL${brandScope}
      ),
      bd AS (
        SELECT wh, src, product_id, sku, nombre, supplier_id, category_id, uxc, caja_cost, deficit_pz,
               deficit_pz * LEAST(1.0, CASE WHEN SUM(deficit_pz) OVER (PARTITION BY src, product_id) > 0
                                            THEN avail_pz / SUM(deficit_pz) OVER (PARTITION BY src, product_id) ELSE 0 END) AS transfer_pz
          FROM def WHERE deficit_pz > 0
      )`;
      const from = `
        FROM bd
        JOIN commercial.warehouses dw ON dw.tenant_id = :t AND dw.id = bd.wh
        JOIN commercial.warehouses sw ON sw.tenant_id = :t AND sw.id = bd.src
        LEFT JOIN catalog.suppliers sup ON sup.tenant_id = :t AND sup.id = bd.supplier_id
        WHERE ${where}`;

      const rows = (await trx.raw(`
        ${cte}
        SELECT bd.product_id, bd.sku, bd.nombre,
               bd.wh AS to_warehouse_id, dw.code AS to_code, dw.name AS to_name,
               bd.src AS from_warehouse_id, sw.code AS from_code,
               sup.name AS supplier_name,
               bd.uxc,
               round(bd.deficit_pz::numeric, 0) AS deficit_pieces,
               round((bd.deficit_pz / bd.uxc)::numeric, 1) AS deficit_cajas,
               round(bd.transfer_pz::numeric, 0) AS transfer_pieces,
               round((bd.transfer_pz / bd.uxc)::numeric, 1) AS transfer_cajas,
               round(GREATEST(0, bd.deficit_pz - bd.transfer_pz)::numeric, 0) AS shortfall_pieces,
               round(bd.caja_cost::numeric, 4) AS unit_cost,
               round(((bd.transfer_pz / bd.uxc) * bd.caja_cost)::numeric, 2) AS transfer_value,
               COUNT(*) OVER() AS _total,
               ROUND(SUM((bd.transfer_pz / bd.uxc) * bd.caja_cost) OVER()::numeric, 2) AS _total_valor,
               ROUND(SUM(bd.transfer_pz / bd.uxc) OVER()::numeric, 0) AS _total_cajas
        ${from}
        ORDER BY (bd.transfer_pz / bd.uxc) * bd.caja_cost DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, binds)).rows;

      const agg: any = rows[0] || {};
      return {
        total: Number(agg._total || 0),
        total_valor: Number(agg._total_valor || 0),
        total_cajas: Number(agg._total_cajas || 0),
        page, pageSize, coverage_days: cov, rows,
      };
    });
  }

  // ── RA-PRO.19 — Sobrestock (capital inmovilizado) ─────────────────────
  /**
   * Productos con stock por ENCIMA de `over_days` de cobertura, por almacén, con el CAPITAL
   * INMOVILIZADO ($). Topología-aware: una sucursal se mide contra SU venta; el CEDIS contra
   * la DEMANDA DE RED (Σ de las sucursales que surte) — si no, el hub (venta directa ≈ 0)
   * saldría 100% sobrestockeado cuando en realidad es buffer de distribución.
   *
   *   demanda_efectiva = sucursal→su venta diaria · CEDIS→Σ venta diaria de sus sucursales
   *   excedente_pz     = max(0, existencia − demanda_efectiva × over_days)
   *   inmovilizado     = (excedente_pz / uxc) × costo_real_de_caja   (mismo costo que compra/traspaso)
   */
  async overstockList(q: OverstockQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const over = Math.min(365, Math.max(7, Number(q.over_days) || 90));
    const page = Math.max(1, Number(q.page) || 1);
    const cap = q.export ? 100000 : 500;
    const pageSize = Math.min(cap, Math.max(1, Number(q.pageSize) || (q.export ? cap : 50)));
    return this.tk.run(async (trx) => {
      const binds: Record<string, unknown> = { t: tenantId, over };
      const filters: string[] = ['ov.surplus_pz > 0'];
      if (q.warehouse_id && UUID_RX.test(q.warehouse_id)) { filters.push('ov.wh = :dw'); binds.dw = q.warehouse_id; }
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) { filters.push('ov.supplier_id = :sid'); binds.sid = q.supplier_id; }
      if (q.category_id && UUID_RX.test(q.category_id)) { filters.push('ov.category_id = :cat'); binds.cat = q.category_id; }
      if (q.search && q.search.trim()) { filters.push('(ov.sku ILIKE :s OR ov.nombre ILIKE :s)'); binds.s = `%${q.search.trim()}%`; }
      // Marca: el fact (replenishment_plan) no trae brand_id → acotamos el universo por product_id.
      let brandScope = '';
      if (q.brand_id && UUID_RX.test(q.brand_id)) { brandScope = ' AND rp.product_id IN (SELECT id FROM catalog.products WHERE tenant_id = :t AND brand_id = :bid)'; binds.bid = q.brand_id; }
      const where = filters.join(' AND ');

      // RA-PRO.31 — LEE del fact precomputado (analytics.replenishment_plan) en vez de recomputar
      // ur/dem/stk/econ/eff (el runner lo refresca). suf/bf/caja_cost/eff_daily ya vienen resueltos.
      // Universo = sucursales (source set) + hubs reales (is_hub), SOLO con demanda (eff_daily>0);
      // el stock sin venta va a la pestaña "Stock muerto", no a sobrestock. eff_daily en el fact es
      // demanda en PIEZAS → /suf = unidades de stock/día (igual que el recompute ov.eff_daily).
      const cte = `WITH ov AS (
        SELECT rp.warehouse_id AS wh, rp.product_id, rp.sku, rp.nombre, rp.supplier_id, rp.category_id,
               rp.bf AS uxc, rp.caja_cost, rp.source_warehouse_id,
               rp.eff_daily * COALESCE(rp.season_ratio,1) / rp.suf AS eff_daily, rp.stock_pz,
               -- RA-PRO.41: el sobrestock se mide contra la demanda del HORIZONTE (un SKU navideño con
               -- pila en noviembre no es sobrestock; el mismo en enero sí).
               GREATEST(0, rp.stock_pz - rp.eff_daily * COALESCE(rp.season_ratio,1) / rp.suf * :over) AS surplus_pz
          FROM analytics.replenishment_plan rp
         WHERE rp.tenant_id = :t AND (rp.source_warehouse_id IS NOT NULL OR rp.is_hub) AND rp.eff_daily > 0${brandScope}
      )`;
      const from = `
        FROM ov
        JOIN commercial.warehouses w ON w.tenant_id = :t AND w.id = ov.wh
        LEFT JOIN catalog.suppliers sup ON sup.tenant_id = :t AND sup.id = ov.supplier_id
        WHERE ${where}`;

      const rows = (await trx.raw(`
        ${cte}
        SELECT ov.product_id, ov.sku, ov.nombre,
               ov.wh AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
               (w.source_warehouse_id IS NULL) AS is_hub,
               sup.name AS supplier_name, ov.uxc,
               round(ov.stock_pz::numeric, 0) AS on_hand_pieces,
               round((ov.stock_pz / ov.uxc)::numeric, 1) AS on_hand_cajas,
               round((ov.surplus_pz / ov.uxc)::numeric, 1) AS surplus_cajas,
               round(ov.surplus_pz::numeric, 0) AS surplus_pieces,
               CASE WHEN ov.eff_daily > 0 THEN round((ov.stock_pz / ov.eff_daily)::numeric, 0) END AS days_on_hand,
               round(ov.caja_cost::numeric, 4) AS unit_cost,
               round(((ov.surplus_pz / ov.uxc) * ov.caja_cost)::numeric, 2) AS immobilized_value,
               COUNT(*) OVER() AS _total,
               ROUND(SUM((ov.surplus_pz / ov.uxc) * ov.caja_cost) OVER()::numeric, 2) AS _total_valor,
               ROUND(SUM(ov.surplus_pz / ov.uxc) OVER()::numeric, 0) AS _total_cajas
        ${from}
        ORDER BY (ov.surplus_pz / ov.uxc) * ov.caja_cost DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, binds)).rows;

      const agg: any = rows[0] || {};
      return {
        total: Number(agg._total || 0),
        total_valor: Number(agg._total_valor || 0),
        total_cajas: Number(agg._total_cajas || 0),
        page, pageSize, over_days: over, rows,
      };
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
      const it = this.inTransit();   // pesado por P(llega) — ver inTransit()
      // Base GLOBAL (como "Objetivo" de Existencia Crítica): el sugerido llena hasta el
      // nivel elegido (cadencia/máximo/reorden/mínimo) con la MISMA fórmula que criticalStock
      // (que alimenta el drill) → la columna "Costo est." y el detalle SIEMPRE coinciden y
      // reaccionan al filtro base. La cadencia sigue mandando el "cuándo" (next_due).
      const basis = this.basis(q.target_basis);
      // RA-PRO.13 — base 'cadence' (default de la pantalla): llena SOLO para el ciclo del
      // proveedor (demanda × (cadencia + lead) + safety), no hasta el máximo — que en artículos
      // lumpy (globos, CV alto) es ~1 año de cobertura e infla el pedido 5-10x. Misma fórmula
      // que criticalStock (helper cadenceTarget()); la LATERAL ve rc.*/sup.* del outer, así total y drill cuadran.
      const target = basis === 'cadence' ? this.cadenceTarget() : this.targetCol(basis);
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
                  LEFT JOIN analytics.replenishment_plan rpl ON rpl.tenant_id=rp.tenant_id AND rpl.warehouse_id=rp.warehouse_id AND rpl.product_id=rp.product_id
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
    // ADR-052 — la existencia sale de la vista derivada del ODS (`qty_stock_units`), no de la copia
    // `commercial.stock`. Importa acá porque este panel vive en la MISMA pantalla que el Pedido
    // (tab "Stock muerto") y el Pedido ya lee la vista: con dos fuentes, la pantalla se contradecía
    // sola. Contra el POS en vivo la vista acierta 100.0% y la copia 91.0%.
    //
    // La vista sirve la existencia en la UNIDAD NATIVA de cada fuente y no la convierte (ver
    // mig 20260902200000: la demanda de Wincaja viene en esa misma unidad, así que convertir sólo
    // la existencia rompía el cálculo). Para MOSTRAR cajas está `display_box_factor`.
    //
    // ⚠️ DEUDA PREEXISTENTE (ADR-051): el multiplicador es `cost_with_tax`/`cost_base` del
    // CATÁLOGO, que en buena parte viene por CAJA, no por la unidad de stock — así que el
    // "inmovilizado" mezcla unidades y está inflado para esos SKUs. El costo correcto por unidad
    // de stock es `analytics.v_supplier_cost_ladder.box_cost / display_box_factor`. Se DECLARA acá
    // en vez de dibujarlo: arreglarlo es de la Fase MR, no de este cambio de fuente.
    const valueExpr = 'COALESCE(s.qty_stock_units,0) * COALESCE(pr.cost_with_tax, pr.cost_base, 0)';
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
        .leftJoin('analytics.v_erp_stock_on_hand as s', (j) =>
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
          trx.raw('COALESCE(s.qty_stock_units,0) AS on_hand'),
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
      // Marcas con productos en política (mismo patrón que proveedores) — para el filtro de /compras/pedido.
      // OJO: la columna de catalog.brands es `nombre`, NO `name` (b.name tiraba 42703 → /filters 500,
      // y con él se caían TODOS los selects de la pantalla). La etiqueta usa display_name cuando
      // existe (nombre legal completo vs. el comercial), igual que catalog-search.
      const brands = await trx('commercial.reorder_policy as rp')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .join('catalog.brands as b', (j) => j.on('b.tenant_id', 'pr.tenant_id').andOn('b.id', 'pr.brand_id'))
        .where('rp.tenant_id', tenantId)
        .whereNull('b.deleted_at')
        .distinct('b.id as id', trx.raw('COALESCE(b.display_name, b.nombre) as name'))
        .orderByRaw('COALESCE(b.display_name, b.nombre)');
      // RA-PRO.12 — categorías de compra (sourcing, ej. Guadalajara/Arandas): las que tienen
      // productos activos con política. n_suppliers/n_products alimentan la etiqueta del selector.
      // Depuración del selector (RA-PRO.12): la categoría de Kepler = campo libre de Wincaja
      // (mismo origen, 100% alineado por código+nombre). Está contaminado con ~84% de nombres de
      // PROVEEDOR + etiquetas de ESTATUS + basura. Para el filtro de COMPRA excluimos:
      //  · estatus/ciclo de vida (A ELIMINAR / BAJA ROTACIÓN / OBSOLETO / DESCONTINUADO): no son
      //    categorías de sourcing y un pedido no debe armarse sobre productos marcados a eliminar.
      //  · basura sin al menos 3 alfanuméricos ('***', 'A', 'AB').
      // Se conservan proveedores + plazas + tipos; el selector es buscable por código y nombre.
      const categories = await trx('commercial.reorder_policy as rp')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'rp.tenant_id').andOn('pr.id', 'rp.product_id'))
        .join('catalog.categories as c', (j) => j.on('c.tenant_id', 'pr.tenant_id').andOn('c.id', 'pr.category_id'))
        .where('rp.tenant_id', tenantId).andWhere('pr.activo', true).whereNull('c.deleted_at')
        .andWhereRaw(`c.name !~* '(ELIMINAR|BAJA ROTAC|OBSOLET|DESCONTINU|NO USAR|NO UTILIZAR)'`)
        .andWhereRaw(`btrim(coalesce(c.name,'')) ~ '[[:alnum:]]{3}'`)
        .groupBy('c.id', 'c.code', 'c.name')
        .select('c.id as id', 'c.code as code', 'c.name as name')
        .countDistinct('pr.supplier_id as n_suppliers')
        .countDistinct('pr.id as n_products')
        .orderBy('c.name');
      return { warehouses, suppliers, brands, categories };
    });
  }

  // ── RA-PRO.12 — Categorías de compra: normalización (admin) ───────────
  /** Todas las categorías activas + # productos / # proveedores + flag de duplicado por nombre. */
  async listCategories(q: { search?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = trx('catalog.categories as c')
        .leftJoin('catalog.products as p', (j) => j.on('p.tenant_id', 'c.tenant_id').andOn('p.category_id', 'c.id'))
        .where('c.tenant_id', tenantId).whereNull('c.deleted_at');
      if (q.search && q.search.trim()) { const s = `%${q.search.trim()}%`; base.andWhere((b) => b.whereILike('c.name', s).orWhereILike('c.code', s)); }
      const rows: any[] = await base
        .groupBy('c.id', 'c.code', 'c.name')
        .select('c.id as id', 'c.code as code', 'c.name as name',
          trx.raw('count(DISTINCT p.id) FILTER (WHERE p.activo)::int as n_products'),
          trx.raw('count(DISTINCT p.supplier_id) FILTER (WHERE p.activo)::int as n_suppliers'))
        .orderByRaw('count(DISTINCT p.id) FILTER (WHERE p.activo) DESC, c.name ASC');
      const nameCount = new Map<string, number>();
      rows.forEach((r) => nameCount.set(r.name, (nameCount.get(r.name) || 0) + 1));
      return rows.map((r) => ({ ...r, is_duplicate: (nameCount.get(r.name) || 0) > 1 }));
    });
  }

  /** Renombra una categoría (normalización manual). */
  async renameCategory(id: string, name: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    const clean = (name || '').trim();
    if (!clean) throw new BadRequestException('name requerido');
    return this.tk.run(async (trx) => {
      const n = await trx('catalog.categories').where({ tenant_id: tenantId, id }).whereNull('deleted_at')
        .update({ name: clean, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Categoría no encontrada');
      return { id, name: clean };
    });
  }

  /** Fusiona categorías: repunta los productos de from_ids → into_id y soft-borra las fusionadas. */
  async mergeCategories(intoId: string, fromIds: string[]) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(intoId)) throw new BadRequestException('into_id inválido');
    const from = (fromIds || []).filter((x) => UUID_RX.test(x) && x !== intoId);
    if (!from.length) throw new BadRequestException('Nada que fusionar');
    return this.tk.run(async (trx) => {
      const into: any = await trx('catalog.categories').where({ tenant_id: tenantId, id: intoId }).whereNull('deleted_at').first();
      if (!into) throw new NotFoundException('Categoría destino no encontrada');
      const products_repointed = await trx('catalog.products')
        .where('tenant_id', tenantId).whereIn('category_id', from).update({ category_id: intoId, updated_at: trx.fn.now() });
      const merged = await trx('catalog.categories')
        .where('tenant_id', tenantId).whereIn('id', from).whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now() });
      this.logger.log(`Categorías fusionadas → ${into.name}: ${merged} cats, ${products_repointed} productos`);
      return { into: into.name, merged, products_repointed };
    });
  }

  /** Auto-dedup: fusiona categorías de NOMBRE IDÉNTICO (canónica = la de más productos). Solo nombres exactos. */
  async autoDedupCategories() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const dupNames: any[] = await trx('catalog.categories')
        .where('tenant_id', tenantId).whereNull('deleted_at')
        .groupBy('name').havingRaw('count(*) > 1').select('name');
      let groups = 0, merged = 0, products_repointed = 0;
      for (const { name } of dupNames) {
        const cats: any[] = await trx('catalog.categories as c')
          .leftJoin('catalog.products as p', (j) => j.on('p.tenant_id', 'c.tenant_id').andOn('p.category_id', 'c.id'))
          .where('c.tenant_id', tenantId).whereNull('c.deleted_at').andWhere('c.name', name)
          .groupBy('c.id', 'c.code')
          .select('c.id', 'c.code', trx.raw('count(p.id)::int np'))
          .orderByRaw('count(p.id) DESC, c.code ASC');
        if (cats.length < 2) continue;
        const rest = cats.slice(1).map((c) => c.id);
        const rp = await trx('catalog.products').where('tenant_id', tenantId).whereIn('category_id', rest)
          .update({ category_id: cats[0].id, updated_at: trx.fn.now() });
        await trx('catalog.categories').where('tenant_id', tenantId).whereIn('id', rest).update({ deleted_at: trx.fn.now() });
        groups++; merged += rest.length; products_repointed += rp;
      }
      this.logger.log(`Auto-dedup categorías: ${groups} grupos, ${merged} fusionadas, ${products_repointed} productos`);
      return { groups, merged, products_repointed };
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
      // Guard anti-doble-recepción: si esta requisición ya generó una OC (no cancelada), la
      // entrada de mercancía DEBE ir por el flujo OC→OE (createReceipt), que mueve stock y marca
      // la RQ 'received' al cerrar. Este atajo (RA.14, sin movimiento) solo aplica a requisiciones
      // ordenadas manualmente (markOrdered) sin OC. Evita estados divergentes / doble conteo.
      const linkedPO: any = await trx('commercial.purchase_orders')
        .where({ tenant_id: tenantId, requisition_id: id }).whereNot('estado', 'cancelled')
        .first('folio');
      if (linkedPO) throw new BadRequestException(`La requisición tiene una OC (${linkedPO.folio}); recibe la mercancía desde la orden de compra.`);

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
      const ready = await this.personalizationReady(trx);
      const st: any = ready ? await trx('commercial.replenishment_settings').where({ tenant_id: tenantId }).first() : this.DEFAULT_SETTINGS;
      const fwin = Math.max(30, Number(st?.fill_window_days) || 180);
      const fmin = Math.max(1, Number(st?.fill_min_lines) || 3);
      // Columnas de override: reales si la migración aplicó, si no NULL (degradado a auto+global).
      const ovCols = ready
        ? ['sup.fill_rate_override', 'sup.safety_pct', 'sup.coverage_days_override']
        : ['NULL::numeric AS fill_rate_override', 'NULL::numeric AS safety_pct', 'NULL::int AS coverage_days_override'];
      const groupCols = ['sup.id', 'sup.name', 'sup.lead_time_days', 'sup.min_order_boxes', 'sup.cadence_days_override', 'sup.colchon_days', 'sup.min_order_amount', ...(ready ? ['sup.fill_rate_override', 'sup.safety_pct', 'sup.coverage_days_override'] : [])];
      const base = trx('catalog.suppliers as sup')
        .leftJoin('catalog.products as pr', (j) => j.on('pr.tenant_id', 'sup.tenant_id').andOn('pr.supplier_id', 'sup.id'))
        .where('sup.tenant_id', tenantId);
      if (q?.search && q.search.trim()) base.andWhereILike('sup.name', `%${q.search.trim()}%`);
      const rows: any[] = await base
        .groupBy(groupCols)
        .select('sup.id', 'sup.name',
          trx.raw('sup.lead_time_days AS lead_time_days'),
          trx.raw('sup.min_order_boxes AS min_order_boxes'),
          trx.raw('sup.cadence_days_override AS cadence_days_override'),
          trx.raw('sup.colchon_days AS colchon_days'),
          trx.raw('sup.min_order_amount AS min_order_amount'),
          // RA-PRO.27 — personalización del pedido (override manual; NULL si migración pendiente)
          trx.raw(ovCols[0]), trx.raw(ovCols[1]), trx.raw(ovCols[2]),
          trx.raw('COUNT(pr.id)::int AS product_count'))
        .orderBy('sup.name');

      // RA-PRO.27.2 — ANÁLISIS AUTOMÁTICO por proveedor (mismo que usa el motor): fill rate por
      // historia, cobertura por cadencia+lead, colchón por variabilidad. Se muestra como el valor
      // vigente cuando no hay override manual.
      const auto: any[] = (await trx.raw(`
        SELECT s.id AS supplier_id,
               CASE WHEN cad.recs >= 2 AND cad.cadence > 0 THEN ceil(cad.cadence + COALESCE(s.lead_time_days, 7)) END AS auto_coverage_days,
               CASE WHEN cv.cv >= 1.0 THEN 20 WHEN cv.cv >= 0.5 THEN 10 ELSE 0 END AS auto_safety_pct,
               CASE WHEN fr.n >= :fmin AND fr.ord > 0 THEN round(LEAST(1.0, fr.recv::numeric / fr.ord), 3) END AS fill_rate_auto,
               COALESCE(fr.n, 0)::int AS fill_receptions
          FROM catalog.suppliers s
          LEFT JOIN (SELECT p.supplier_id, avg(rp.demand_cv) cv FROM catalog.products p
                       JOIN commercial.reorder_policy rp ON rp.tenant_id = p.tenant_id AND rp.product_id = p.id
                      WHERE p.tenant_id = :t AND p.supplier_id IS NOT NULL AND rp.demand_cv IS NOT NULL GROUP BY p.supplier_id) cv ON cv.supplier_id = s.id
          LEFT JOIN (SELECT po.supplier_id,
                            (max(po.closed_at::date) - min(po.closed_at::date))::numeric / NULLIF(count(*) - 1, 0) cadence, count(*) recs
                       FROM commercial.purchase_orders po
                      WHERE po.tenant_id = :t AND po.source_type = 'supplier' AND po.estado IN ('received','partial')
                        AND po.closed_at IS NOT NULL AND po.closed_at >= now() - make_interval(days => :fwin::int) GROUP BY po.supplier_id) cad ON cad.supplier_id = s.id
          LEFT JOIN (SELECT po.supplier_id, SUM(pol.received_qty) recv, SUM(pol.ordered_qty) ord, COUNT(*) n
                       FROM commercial.purchase_orders po JOIN commercial.purchase_order_lines pol ON pol.tenant_id = po.tenant_id AND pol.purchase_order_id = po.id
                      WHERE po.tenant_id = :t AND po.source_type = 'supplier' AND po.estado IN ('received','partial') AND po.supplier_id IS NOT NULL
                        AND COALESCE(po.closed_at, po.created_at) >= now() - make_interval(days => :fwin::int) GROUP BY po.supplier_id) fr ON fr.supplier_id = s.id
         WHERE s.tenant_id = :t`, { t: tenantId, fmin, fwin })).rows;
      const byId = new Map(auto.map((a) => [a.supplier_id, a]));
      return rows.map((r) => ({ ...r, ...(byId.get(r.id) || {}) }));
    });
  }

  // ── RA-PRO.28 — Override manual de unidad de venta por producto ───────
  /** Fija/borra SUF (pieces_per_unit) y BF (box_factor) de un producto. null en ambos = borra. */
  async setProductUnitOverride(productId: string, patch: { pieces_per_unit?: number | null; box_factor?: number | null; sold_as?: string | null; note?: string | null }) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(productId)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) => {
      if (!(await this.unitOverrideReady(trx))) throw new BadRequestException('Override de unidad no disponible: falta aplicar la migración 20260728180000.');
      const num = (v: unknown) => v == null || Number.isNaN(Number(v)) || Number(v) <= 0 ? null : Number(v);
      const suf = num(patch.pieces_per_unit), bf = num(patch.box_factor);
      const userId = this.tenantCtx.get()?.userId ?? null;
      if (suf == null && bf == null) {
        await trx('commercial.product_unit_overrides').where({ tenant_id: tenantId, product_id: productId }).update({ deleted_at: trx.fn.now() });
        return { product_id: productId, cleared: true };
      }
      const existing = await trx('commercial.product_unit_overrides')
        .where({ tenant_id: tenantId, product_id: productId }).whereNull('deleted_at').first('id');
      const vals = { pieces_per_unit: suf, box_factor: bf, sold_as: patch.sold_as ?? null, note: patch.note ?? null, updated_at: trx.fn.now(), deleted_at: null };
      if (existing) await trx('commercial.product_unit_overrides').where({ id: existing.id }).update(vals);
      else await trx('commercial.product_unit_overrides').insert({ tenant_id: tenantId, product_id: productId, created_by: userId, ...vals });
      return { product_id: productId, pieces_per_unit: suf, box_factor: bf };
    });
  }

  // ── RA-PRO.6 — Topología de red de abasto (DRP CEDIS→sucursal) ────────
  /** Almacenes reales con su origen de surtido; is_cedis = referenciado por ≥1 sucursal. */
  async networkTopology() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.warehouses as w')
        .leftJoin('commercial.warehouses as src', (j) => j.on('src.tenant_id', 'w.tenant_id').andOn('src.id', 'w.source_warehouse_id'))
        // RA-PRO.25 — cadencia REAL de surtido del CEDIS (Wincaja Irapuato, caja 99) por sucursal.
        .leftJoin('analytics.cedis_supply_cadence as cc', (j) =>
          j.on('cc.tenant_id', 'w.tenant_id').andOn('cc.warehouse_id', 'w.id').andOnVal('cc.window_year', new Date().getFullYear()))
        .where('w.tenant_id', tenantId).whereNull('w.deleted_at').andWhere('w.kind', '<>', 'truck')
        // Excluye almacenes efímeros de tests/procesos (conteo, equipos, caducidad, ventas).
        .andWhereRaw(`w.code !~ '^(INV|TEAMWH|EXPALERT|SOLDEXP|TRUCK)'`)
        .select('w.id', 'w.code', 'w.name', 'w.source_warehouse_id',
          trx.raw('src.code AS source_code'),
          trx.raw(`EXISTS (SELECT 1 FROM commercial.warehouses c WHERE c.tenant_id=w.tenant_id AND c.source_warehouse_id=w.id AND c.deleted_at IS NULL) AS is_cedis`),
          trx.raw('cc.cadence_days AS supply_cadence_days'),       // cada cuántos días lo surte el CEDIS
          trx.raw('cc.shipments AS supply_shipments'),             // # envíos en el año
          trx.raw('cc.last_shipment AS supply_last'),              // último surtido
          trx.raw('cc.avg_shipment_value AS supply_avg_value'))    // $ costo promedio por envío
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
  async setSupplierOrderParams(supplierId: string, patch: { cadence_days_override?: number | null; colchon_days?: number | null; min_order_amount?: number | null; min_order_boxes?: number | null; fill_rate_override?: number | null; safety_pct?: number | null; coverage_days_override?: number | null }) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(supplierId)) throw new BadRequestException('supplier_id inválido');
    const clampInt = (v: unknown, max: number) => v == null || Number.isNaN(Number(v)) ? null : Math.min(max, Math.max(0, Math.round(Number(v))));
    const clampNum = (v: unknown) => v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Number(v));
    // fill rate manual en 0..1: acepta también 0..100 (%) y lo normaliza.
    const clampFill = (v: unknown) => { if (v == null || Number.isNaN(Number(v))) return null; let n = Number(v); if (n > 1) n = n / 100; return Math.min(1, Math.max(0.01, n)); };
    return this.tk.run(async (trx) => {
      const ready = await this.personalizationReady(trx);
      const upd: Record<string, unknown> = { updated_at: trx.fn.now() };
      if ('cadence_days_override' in patch) upd.cadence_days_override = clampInt(patch.cadence_days_override, 365);
      if ('colchon_days' in patch) upd.colchon_days = clampInt(patch.colchon_days, 365);
      if ('min_order_amount' in patch) upd.min_order_amount = clampNum(patch.min_order_amount);
      if ('min_order_boxes' in patch) upd.min_order_boxes = clampInt(patch.min_order_boxes, 1000000);
      // RA-PRO.27 — personalización del pedido por proveedor (solo si la migración ya aplicó).
      if (ready && 'fill_rate_override' in patch) upd.fill_rate_override = clampFill(patch.fill_rate_override);
      if (ready && 'safety_pct' in patch) upd.safety_pct = patch.safety_pct == null || Number.isNaN(Number(patch.safety_pct)) ? null : Math.min(100, Math.max(0, Number(patch.safety_pct)));
      if (ready && 'coverage_days_override' in patch) upd.coverage_days_override = clampInt(patch.coverage_days_override, 120);
      const n = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).update(upd);
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return { id: supplierId, ...upd, updated_at: undefined };
    });
  }

  // ── RA-PRO.27 — Parámetros GLOBALES del pedido (fill rate + cobertura) ──
  async getReplenishmentSettings() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.personalizationReady(trx))) return this.DEFAULT_SETTINGS; // migración pendiente → defaults
      let row: any = await trx('commercial.replenishment_settings').where({ tenant_id: tenantId }).first();
      if (!row) {
        await trx('commercial.replenishment_settings').insert({ tenant_id: tenantId }).onConflict('tenant_id').ignore();
        row = await trx('commercial.replenishment_settings').where({ tenant_id: tenantId }).first();
      }
      return row;
    });
  }

  async updateReplenishmentSettings(patch: { fill_window_days?: number; fill_min_lines?: number; fill_max_inflate?: number; default_coverage_days?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      if (!(await this.personalizationReady(trx))) throw new BadRequestException('Parámetros globales no disponibles aún: falta aplicar la migración 20260728170000 en este entorno.');
      const upd: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: userId };
      if ('fill_window_days' in patch) upd.fill_window_days = Math.min(730, Math.max(30, Math.round(Number(patch.fill_window_days) || 180)));
      if ('fill_min_lines' in patch) upd.fill_min_lines = Math.min(50, Math.max(1, Math.round(Number(patch.fill_min_lines) || 3)));
      if ('fill_max_inflate' in patch) upd.fill_max_inflate = Math.min(3, Math.max(1, Number(patch.fill_max_inflate) || 1.30));
      if ('default_coverage_days' in patch) upd.default_coverage_days = Math.min(120, Math.max(1, Math.round(Number(patch.default_coverage_days) || 30)));
      await trx('commercial.replenishment_settings')
        .insert({ tenant_id: tenantId, ...upd })
        .onConflict('tenant_id').merge(upd);
      return trx('commercial.replenishment_settings').where({ tenant_id: tenantId }).first();
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
    // RA-PRO.28.2 — "Ver pedido" reutiliza EXACTAMENTE el motor de /compras/pedido
    // (purchaseSuggestion): demanda limpia + verificación de unidad SUF/BF + fill rate +
    // costo real de caja. Antes usaba inventory_health.avg_daily_units (unidad contaminada)
    // y factor_sale sin corregir → inflaba granel y no cuadraba con /pedido. Sobre esas líneas
    // (grano RED por producto) se aplica el mínimo de compra del proveedor.
    const sup = await this.tk.run(async (trx) =>
      trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId })
        .first('id', 'name', 'cadence_days_override', 'colchon_days', 'min_order_boxes', 'min_order_amount', 'lead_time_days')) as any;
    if (!sup) throw new NotFoundException('Proveedor no encontrado');
    {
      const res = await this.purchaseSuggestion({ supplier_id: supplierId, scope: 'needed', pageSize: 100000, export: true });
      const lines = res.rows.map((r: any) => ({
        warehouse_code: r.warehouse_code, warehouse_id: r.warehouse_id, product_id: r.product_id, sku: r.sku, nombre: r.nombre,
        on_hand: Math.round(Number(r.on_hand_units) || 0), avg_daily: Number(r.sell_daily_cajas) || 0,
        uxc: Number(r.uxc) || 1, unit_cost: Number(r.unit_cost) || 0,
        suggested: Math.round(Number(r.suggested_units) || 0), final: Math.round(Number(r.suggested_units) || 0),
      })).filter((l: any) => l.suggested > 0);

      const minBoxes = sup.min_order_boxes != null ? Number(sup.min_order_boxes) : null;
      const minAmount = sup.min_order_amount != null ? Number(sup.min_order_amount) : null;
      // final está en CAJAS (canónico: suggested = objetivo_cajas − stock_cajas). uxc = piezas/caja
      // sólo para la vista dual. cajas = final; piezas = final × uxc; $ = final × costo_caja.
      const tot = () => ({
        cajas: lines.reduce((s, l) => s + l.final, 0),
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
        const short = minBoxes - before.cajas; // faltante en CAJAS → se reparte en cajas (final ya es cajas)
        for (const l of lines) { const w = (Math.max(l.avg_daily, 0) || 1) / sumAvg; l.final += Math.max(0, Math.round(short * w)); }
        padded = true;
      }
      const after = tot();
      return {
        supplier: { id: sup.id, name: sup.name, cadence_days_override: sup.cadence_days_override, colchon_days: sup.colchon_days, min_order_boxes: minBoxes, min_order_amount: minAmount },
        padded,
        totals: { cajas: Math.round(after.cajas * 10) / 10, amount: Math.round(after.amount * 100) / 100, lines: lines.length,
                  suggested_cajas: Math.round(before.cajas * 10) / 10, suggested_amount: Math.round(before.amount * 100) / 100 },
        lines: lines.map((l) => ({ ...l, cajas: l.final, piezas: l.final * l.uxc, line_cost: Math.round(l.final * l.unit_cost * 100) / 100 })),
      };
    }
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
