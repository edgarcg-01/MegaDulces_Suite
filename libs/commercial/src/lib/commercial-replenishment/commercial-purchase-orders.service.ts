import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * RA.15 — Cadena de compra real (ADR-031). Orden de Compra (OC) + Orden de Entrada (OE).
 *
 * Espeja los eslabones con valor operativo de Kepler (verificado en md_03 vivo):
 *   Requisición (RQ, ya existente) = necesidad + aprobación HITL.
 *   OC (commercial.purchase_orders, ~X-A-35) = lo que se manda al proveedor.
 *   OE (commercial.goods_receipts, ~X-A-40)  = recepción (parciales) que MUEVE stock.
 *
 * La OE aplica un movimiento 'in' a commercial.stock (overlay optimista, mismo patrón que
 * CommercialInventoryService.recordMovement con lock pesimista). El snapshot nocturno de
 * Kepler re-sincroniza la existencia (verdad del inventario) → no hay doble-conteo
 * permanente. Traspaso (branch): además descuenta el origen best-effort (clamp a disponible).
 *
 * Todo dentro de TenantKnexService.run() (SET LOCAL app.tenant_id → RLS forzado).
 */

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreatePurchaseOrderLineDto {
  product_id: string;
  ordered_qty: number;
  unit_cost?: number;
  requisition_line_id?: string | null;
}
export interface CreatePurchaseOrderDto {
  warehouse_id: string;
  supplier_id?: string | null;
  source_type?: string;                 // 'supplier' | 'branch'
  source_warehouse_id?: string | null;
  requisition_id?: string | null;
  expected_date?: string | null;        // YYYY-MM-DD
  target_basis?: string;
  notes?: string;
  lines: CreatePurchaseOrderLineDto[];
}
export interface ReceiptLineDto {
  po_line_id: string;
  received_qty: number;
  unit_cost?: number;                    // costo real; default = costo pactado de la línea OC
}
export interface CreateReceiptDto {
  lines: ReceiptLineDto[];
  notes?: string;
  received_at?: string | null;           // YYYY-MM-DD (default hoy)
}

@Injectable()
export class CommercialPurchaseOrdersService {
  private readonly logger = new Logger(CommercialPurchaseOrdersService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private basis(v?: string) { return ['min', 'reorder', 'max'].includes(v || '') ? v! : 'max'; }

  /** Folio atómico OC-YYYY-NNNNN / OE-YYYY-NNNNN por tenant×año×tipo. */
  private async nextFolio(trx: any, tenantId: string, kind: 'OC' | 'OE', year: number): Promise<string> {
    const r = await trx.raw(
      `INSERT INTO commercial.purchase_doc_sequences (tenant_id, year, doc_kind, last_seq) VALUES (?, ?, ?, 1)
       ON CONFLICT (tenant_id, year, doc_kind) DO UPDATE SET last_seq = commercial.purchase_doc_sequences.last_seq + 1
       RETURNING last_seq`, [tenantId, year, kind]);
    return `${kind}-${year}-${String(r.rows[0].last_seq).padStart(5, '0')}`;
  }

  // ── Crear OC directa ──────────────────────────────────────────────────
  async createPurchaseOrder(dto: CreatePurchaseOrderDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!dto?.warehouse_id || !UUID_RX.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const isBranch = dto.source_type === 'branch';
    const srcWh = isBranch && dto.source_warehouse_id && UUID_RX.test(dto.source_warehouse_id) ? dto.source_warehouse_id : null;
    if (isBranch && !srcWh) throw new BadRequestException('El traspaso (branch) requiere almacén origen');
    const lines = (dto.lines || []).filter((l) => l && UUID_RX.test(l.product_id) && Number(l.ordered_qty) > 0);
    if (!lines.length) throw new BadRequestException('La OC no tiene líneas con cantidad > 0');

    return this.tk.run(async (trx) => {
      const year = new Date().getFullYear();
      const folio = await this.nextFolio(trx, tenantId, 'OC', year);
      let totalUnits = 0, totalCost = 0;
      for (const l of lines) { totalUnits += Number(l.ordered_qty); totalCost += Number(l.ordered_qty) * Number(l.unit_cost || 0); }

      const [po] = await trx('commercial.purchase_orders').insert({
        tenant_id: tenantId, folio, warehouse_id: dto.warehouse_id,
        supplier_id: !isBranch && dto.supplier_id && UUID_RX.test(dto.supplier_id) ? dto.supplier_id : null,
        source_type: isBranch ? 'branch' : 'supplier', source_warehouse_id: srcWh,
        requisition_id: dto.requisition_id && UUID_RX.test(dto.requisition_id) ? dto.requisition_id : null,
        expected_date: dto.expected_date || null, estado: 'open', target_basis: this.basis(dto.target_basis),
        total_lines: lines.length, total_units: totalUnits, total_cost: Number(totalCost.toFixed(4)),
        notes: dto.notes ?? null, created_by: userId,
      }).returning(['id', 'folio', 'estado']);

      await trx('commercial.purchase_order_lines').insert(lines.map((l) => ({
        tenant_id: tenantId, purchase_order_id: po.id, product_id: l.product_id,
        requisition_line_id: l.requisition_line_id && UUID_RX.test(l.requisition_line_id) ? l.requisition_line_id : null,
        ordered_qty: Number(l.ordered_qty), received_qty: 0,
        unit_cost: Number(l.unit_cost || 0), line_cost: Number((Number(l.ordered_qty) * Number(l.unit_cost || 0)).toFixed(4)),
      })));

      this.logger.log(`OC ${folio} creada (${lines.length} líneas, ${totalUnits} u) por ${userId ?? 'system'}`);
      return { id: po.id, folio: po.folio, estado: po.estado, total_lines: lines.length, total_units: totalUnits, total_cost: totalCost };
    });
  }

  /**
   * RA.15 — genera la OC desde una requisición APROBADA (una RQ = un proveedor/origen,
   * ya viene partida). Marca la requisición 'ordered' (convertida) y enlaza la OC.
   */
  async createFromRequisition(requisitionId: string, opts?: { expected_date?: string | null; notes?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(requisitionId)) throw new BadRequestException('requisition_id inválido');
    return this.tk.run(async (trx) => {
      const req: any = await trx('commercial.purchase_requisitions')
        .where({ tenant_id: tenantId, id: requisitionId }).forUpdate().first();
      if (!req) throw new NotFoundException('Requisición no encontrada');
      if (req.estado !== 'approved') throw new BadRequestException(`Solo se genera OC de una requisición aprobada (está '${req.estado}')`);
      const existing = await trx('commercial.purchase_orders')
        .where({ tenant_id: tenantId, requisition_id: requisitionId }).whereNot('estado', 'cancelled').first('id', 'folio');
      if (existing) throw new ConflictException(`La requisición ya tiene OC (${existing.folio})`);

      const reqLines = await trx('commercial.purchase_requisition_lines')
        .where({ tenant_id: tenantId, requisition_id: requisitionId }).select('*');
      const lines = reqLines.filter((l: any) => Number(l.final_qty) > 0);
      if (!lines.length) throw new BadRequestException('La requisición no tiene líneas con cantidad > 0');

      const userId = this.tenantCtx.get()?.userId ?? null;
      const year = new Date().getFullYear();
      const folio = await this.nextFolio(trx, tenantId, 'OC', year);
      const isBranch = req.source_type === 'branch';
      let totalUnits = 0, totalCost = 0;
      for (const l of lines) { totalUnits += Number(l.final_qty); totalCost += Number(l.final_qty) * Number(l.unit_cost || 0); }

      const [po] = await trx('commercial.purchase_orders').insert({
        tenant_id: tenantId, folio, warehouse_id: req.warehouse_id,
        supplier_id: isBranch ? null : req.supplier_id, source_type: isBranch ? 'branch' : 'supplier',
        source_warehouse_id: isBranch ? req.source_warehouse_id : null, requisition_id: requisitionId,
        expected_date: opts?.expected_date || null, estado: 'open', target_basis: req.target_basis,
        total_lines: lines.length, total_units: totalUnits, total_cost: Number(totalCost.toFixed(4)),
        notes: opts?.notes ?? req.notes ?? null, created_by: userId,
      }).returning(['id', 'folio', 'estado']);

      await trx('commercial.purchase_order_lines').insert(lines.map((l: any) => ({
        tenant_id: tenantId, purchase_order_id: po.id, product_id: l.product_id, requisition_line_id: l.id,
        ordered_qty: Number(l.final_qty), received_qty: 0,
        unit_cost: Number(l.unit_cost || 0), line_cost: Number((Number(l.final_qty) * Number(l.unit_cost || 0)).toFixed(4)),
      })));

      // RQ → ordered (convertida). El CHECK ya incluye 'ordered'.
      await trx('commercial.purchase_requisitions')
        .where({ tenant_id: tenantId, id: requisitionId, estado: 'approved' })
        .update({ estado: 'ordered', updated_at: trx.fn.now() });

      this.logger.log(`OC ${folio} generada desde requisición ${req.folio}`);
      return { id: po.id, folio: po.folio, estado: po.estado, requisition_folio: req.folio, total_units: totalUnits, total_cost: totalCost };
    });
  }

  // ── Listado + detalle ─────────────────────────────────────────────────
  async listPurchaseOrders(q: { estado?: string; supplier_id?: string; warehouse_id?: string; page?: number; pageSize?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    return this.tk.run(async (trx) => {
      const base = trx('commercial.purchase_orders as po')
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'po.tenant_id').andOn('w.id', 'po.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'po.tenant_id').andOn('sup.id', 'po.supplier_id'))
        .leftJoin('commercial.warehouses as src', (j) => j.on('src.tenant_id', 'po.tenant_id').andOn('src.id', 'po.source_warehouse_id'))
        .where('po.tenant_id', tenantId);
      if (q.estado) base.andWhere('po.estado', q.estado);
      if (q.supplier_id && UUID_RX.test(q.supplier_id)) base.andWhere('po.supplier_id', q.supplier_id);
      if (q.warehouse_id && UUID_RX.test(q.warehouse_id)) base.andWhere('po.warehouse_id', q.warehouse_id);
      const totalRow: any = await base.clone().clearSelect().clearOrder().count('* as c').first();
      const rows = await base.clone()
        .select('po.id', 'po.folio', 'po.estado', 'po.source_type', 'po.expected_date',
          'po.total_lines', 'po.total_units', 'po.received_units', 'po.total_cost', 'po.created_at', 'po.closed_at',
          trx.raw('w.code AS warehouse_code'), trx.raw('sup.name AS supplier_name'), trx.raw('src.code AS source_code'))
        .orderBy('po.created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize);
      return { total: Number(totalRow?.c || 0), page, pageSize, rows };
    });
  }

  async getPurchaseOrder(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const header: any = await trx('commercial.purchase_orders as po')
        .leftJoin('commercial.warehouses as w', (j) => j.on('w.tenant_id', 'po.tenant_id').andOn('w.id', 'po.warehouse_id'))
        .leftJoin('catalog.suppliers as sup', (j) => j.on('sup.tenant_id', 'po.tenant_id').andOn('sup.id', 'po.supplier_id'))
        .leftJoin('commercial.warehouses as src', (j) => j.on('src.tenant_id', 'po.tenant_id').andOn('src.id', 'po.source_warehouse_id'))
        .leftJoin('commercial.purchase_requisitions as rq', (j) => j.on('rq.tenant_id', 'po.tenant_id').andOn('rq.id', 'po.requisition_id'))
        .where({ 'po.tenant_id': tenantId, 'po.id': id })
        .select('po.*', trx.raw('w.code AS warehouse_code'), trx.raw('w.name AS warehouse_name'),
          trx.raw('sup.name AS supplier_name'), trx.raw('src.code AS source_code'), trx.raw('rq.folio AS requisition_folio'))
        .first();
      if (!header) throw new NotFoundException('Orden de compra no encontrada');
      const lines = await trx('commercial.purchase_order_lines as l')
        .join('catalog.products as pr', (j) => j.on('pr.tenant_id', 'l.tenant_id').andOn('pr.id', 'l.product_id'))
        .where('l.tenant_id', tenantId).andWhere('l.purchase_order_id', id)
        .select('l.*', trx.raw('pr.sku AS sku'), trx.raw('pr.nombre AS nombre'))
        .orderBy('pr.nombre');
      const receipts = await trx('commercial.goods_receipts')
        .where({ tenant_id: tenantId, purchase_order_id: id })
        .select('id', 'folio', 'total_units', 'total_cost', 'stock_applied', 'received_at', 'notes')
        .orderBy('received_at', 'desc');
      return { ...header, lines, receipts };
    });
  }

  async cancelPurchaseOrder(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const po: any = await trx('commercial.purchase_orders').where({ tenant_id: tenantId, id }).first();
      if (!po) throw new NotFoundException('Orden de compra no encontrada');
      if (po.estado === 'received') throw new BadRequestException('No se puede cancelar una OC ya recibida');
      if (Number(po.received_units) > 0) throw new BadRequestException('No se puede cancelar una OC con recepciones parciales');
      await trx('commercial.purchase_orders').where({ tenant_id: tenantId, id })
        .update({ estado: 'cancelled', cancelled_by: userId, closed_at: trx.fn.now(), updated_at: trx.fn.now() });
      return { id, estado: 'cancelled' };
    });
  }

  // ── OE — recepción (mueve stock) ──────────────────────────────────────
  /** Movimiento de stock inline (mismo contrato que CommercialInventoryService). */
  private async moveStock(trx: any, tenantId: string, userId: string | null, args: {
    warehouse_id: string; product_id: string; kind: 'in' | 'out'; qty: number; ref_id: string; notes?: string;
  }): Promise<number> {
    const stockRow: any = await trx('commercial.stock')
      .where({ warehouse_id: args.warehouse_id, product_id: args.product_id }).forUpdate().first();
    const before = stockRow ? Number(stockRow.quantity) : 0;
    const reserved = stockRow ? Number(stockRow.reserved_quantity) : 0;
    // 'out' (traspaso origen) es best-effort: nunca deja negativo ni bloquea (Kepler reconcilia).
    const applied = args.kind === 'out' ? Math.min(args.qty, Math.max(0, before - reserved)) : args.qty;
    const after = args.kind === 'in' ? before + applied : before - applied;
    if (stockRow) {
      await trx('commercial.stock').where({ id: stockRow.id }).update({ quantity: after, updated_at: trx.fn.now(), updated_by: userId });
    } else {
      await trx('commercial.stock').insert({
        tenant_id: trx.raw('public.current_tenant_id()'), warehouse_id: args.warehouse_id,
        product_id: args.product_id, quantity: after, reserved_quantity: 0, updated_by: userId,
      });
    }
    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'), warehouse_id: args.warehouse_id, product_id: args.product_id,
      movement_type: args.kind, quantity: applied, quantity_before: before, quantity_after: after,
      reference_type: 'goods_receipt', reference_id: args.ref_id, notes: args.notes || null, created_by: userId,
    });
    return applied;
  }

  async createReceipt(poId: string, dto: CreateReceiptDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!UUID_RX.test(poId)) throw new BadRequestException('purchase_order_id inválido');
    const inLines = (dto?.lines || []).filter((l) => l && UUID_RX.test(l.po_line_id) && Number(l.received_qty) > 0);
    if (!inLines.length) throw new BadRequestException('La recepción no tiene líneas con cantidad > 0');

    return this.tk.run(async (trx) => {
      const po: any = await trx('commercial.purchase_orders').where({ tenant_id: tenantId, id: poId }).forUpdate().first();
      if (!po) throw new NotFoundException('Orden de compra no encontrada');
      if (!['open', 'partial'].includes(po.estado)) throw new BadRequestException(`La OC no admite recepción (estado '${po.estado}')`);

      const poLines = await trx('commercial.purchase_order_lines')
        .where({ tenant_id: tenantId, purchase_order_id: poId }).forUpdate().select('*');
      const byId = new Map<string, any>(poLines.map((l: any) => [l.id, l]));
      for (const rl of inLines) {
        if (!byId.has(rl.po_line_id)) throw new BadRequestException(`Línea ${rl.po_line_id} no pertenece a esta OC`);
      }

      const year = new Date().getFullYear();
      const folio = await this.nextFolio(trx, tenantId, 'OE', year);
      const [gr] = await trx('commercial.goods_receipts').insert({
        tenant_id: tenantId, folio, purchase_order_id: poId, warehouse_id: po.warehouse_id,
        total_units: 0, total_cost: 0, stock_applied: true, notes: dto.notes ?? null,
        received_by: userId, received_at: dto.received_at || trx.fn.now(),
      }).returning(['id']);

      const isBranch = po.source_type === 'branch';
      let totalUnits = 0, totalCost = 0;
      const grLines: any[] = [];
      for (const rl of inLines) {
        const pol = byId.get(rl.po_line_id);
        const qty = Number(rl.received_qty);
        const unitCost = rl.unit_cost != null && Number(rl.unit_cost) >= 0 ? Number(rl.unit_cost) : Number(pol.unit_cost || 0);
        const lineCost = Number((qty * unitCost).toFixed(4));
        totalUnits += qty; totalCost += lineCost;
        grLines.push({
          tenant_id: tenantId, goods_receipt_id: gr.id, purchase_order_line_id: pol.id, product_id: pol.product_id,
          received_qty: qty, unit_cost: unitCost, line_cost: lineCost,
        });
        // Mueve stock: +destino (OC.warehouse). Traspaso: además −origen (best-effort).
        await this.moveStock(trx, tenantId, userId, { warehouse_id: po.warehouse_id, product_id: pol.product_id, kind: 'in', qty, ref_id: gr.id, notes: `OE ${folio}` });
        if (isBranch && po.source_warehouse_id) {
          await this.moveStock(trx, tenantId, userId, { warehouse_id: po.source_warehouse_id, product_id: pol.product_id, kind: 'out', qty, ref_id: gr.id, notes: `Traspaso OE ${folio}` });
        }
        await trx('commercial.purchase_order_lines').where({ tenant_id: tenantId, id: pol.id })
          .update({ received_qty: Number(pol.received_qty) + qty });
      }
      await trx('commercial.goods_receipt_lines').insert(grLines);
      await trx('commercial.goods_receipts').where({ tenant_id: tenantId, id: gr.id })
        .update({ total_units: totalUnits, total_cost: Number(totalCost.toFixed(4)) });

      // Recalcula estado de la OC: received si TODO ≥ pedido; partial si hay algo; recibido acumulado.
      const fresh = await trx('commercial.purchase_order_lines')
        .where({ tenant_id: tenantId, purchase_order_id: poId }).select('ordered_qty', 'received_qty');
      const recvUnits = fresh.reduce((s: number, l: any) => s + Number(l.received_qty), 0);
      const complete = fresh.every((l: any) => Number(l.received_qty) >= Number(l.ordered_qty));
      const estado = complete ? 'received' : 'partial';
      await trx('commercial.purchase_orders').where({ tenant_id: tenantId, id: poId })
        .update({ estado, received_units: recvUnits, closed_at: complete ? trx.fn.now() : null, updated_at: trx.fn.now() });

      // Traza: si la OC vino de una requisición y quedó completa, marca la RQ 'received'.
      if (complete && po.requisition_id) {
        await trx('commercial.purchase_requisitions').where({ tenant_id: tenantId, id: po.requisition_id })
          .whereIn('estado', ['ordered', 'approved']).update({ estado: 'received', received_by: userId, received_at: trx.fn.now(), updated_at: trx.fn.now() });
      }

      this.logger.log(`OE ${folio} sobre OC ${po.folio}: ${totalUnits} u, OC→${estado} por ${userId ?? 'system'}`);
      return { id: gr.id, folio, po_estado: estado, total_units: totalUnits, total_cost: totalCost, stock_applied: true };
    });
  }
}
