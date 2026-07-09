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
  bucket?: string;
  source?: string;
  search?: string;
  target_basis?: string;
  scope?: string; // 'all' = todo; default = sólo <= punto de reorden (crítico)
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
        .where('rp.tenant_id', tenantId);

      const whIds = this.whIds(q);
      if (whIds.length) base.whereIn('rp.warehouse_id', whIds);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('pr.supplier_id', q.supplier_id);
      if (q.source && ['kepler', 'computed', 'manual'].includes(q.source)) base.andWhere('rp.source', q.source);
      if (q.abc && ['A', 'B', 'C'].includes(q.abc.toUpperCase())) base.andWhere('abc.abc_class', q.abc.toUpperCase());
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
          trx.raw('sup.id AS supplier_id'),
          trx.raw('sup.name AS supplier_name'),
          trx.raw('sup.min_order_boxes AS supplier_min_boxes'),
          trx.raw('pr.factor_purchase AS factor_purchase'),
          trx.raw('abc.abc_class AS abc_class'),
          trx.raw('pr.cost_base AS unit_cost'),
          trx.raw(`${this.bucketExpr()} AS bucket`),
          trx.raw(`GREATEST(0, ${target} - ${oh} - ${it}) AS suggested_qty`),
          trx.raw(`ROUND(GREATEST(0, ${target} - ${oh} - ${it}) * COALESCE(pr.cost_base,0), 2) AS suggested_cost`),
        )
        // Dinero primero: el sugerido valorizado ($) manda. Sin esto, los 3k+
        // agotados (muchos SKUs admin/insumo con costo 0) acaparan 60+ páginas
        // con existencia 0 y la vista "parece" rota.
        .orderByRaw(`GREATEST(0, ${target} - ${oh} - ${it}) * COALESCE(pr.cost_base, 0) DESC`)
        .orderByRaw(`CASE ${this.bucketExpr()}
            WHEN 'agotado' THEN 0 WHEN 'bajo_minimo' THEN 1 WHEN 'bajo_reorden' THEN 2 WHEN 'sobrestock' THEN 4 ELSE 3 END`)
        .orderByRaw(`GREATEST(0, ${target} - ${oh} - ${it}) DESC`)
        .limit(pageSize).offset((page - 1) * pageSize);

      return { total, page, pageSize, target_basis: basis, rows };
    });
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
        .where('rp.tenant_id', tenantId);
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
          trx.raw(`ROUND(SUM(GREATEST(0, ${target} - ${oh} - ${it}) * COALESCE(pr.cost_base,0)) FILTER (WHERE ${oh} <= rp.reorder_point), 2) AS sugerido_costo`),
        ).first();
      return r;
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
      return { ...header, lines };
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
}
