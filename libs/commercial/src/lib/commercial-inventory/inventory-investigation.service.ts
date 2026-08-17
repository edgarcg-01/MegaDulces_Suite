import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PREV.1 — Expediente de investigación de diferencias de inventario (Apéndice B).
 *
 * Abre un expediente sobre una diferencia confirmada (desde un folio de conteo o
 * manual), arma la LÍNEA DE TIEMPO del SKU (para no navegar 5 módulos), y permite
 * clasificar la CAUSA RAÍZ y cerrar ligando el ajuste. Segregación: COMMERCIAL_PREVENTION_*.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT_CAUSES = ['EC', 'ER', 'EA', 'DC', 'DP', 'TR', 'UB', 'MR', 'PNI'];

export interface OpenInvestigationDto {
  warehouse_id: string;
  product_id: string;
  expected_qty: number;
  physical_qty: number;
  unit_cost?: number;
  reason_code?: string;
  notes?: string;
}

const MOVEMENT_LABELS: Record<string, string> = {
  in: 'Entrada', out: 'Salida', adjust: 'Ajuste', reserve: 'Reserva', release: 'Liberación', sale: 'Venta',
};

@Injectable()
export class InventoryInvestigationService {
  private readonly logger = new Logger(InventoryInvestigationService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private async nextFolio(trx: any): Promise<string> {
    const year = new Date().getFullYear();
    const res = await trx.raw(
      `INSERT INTO commercial.inventory_investigation_sequences (tenant_id, year, last_seq)
         VALUES (public.current_tenant_id(), ?, 1)
       ON CONFLICT (tenant_id, year)
         DO UPDATE SET last_seq = commercial.inventory_investigation_sequences.last_seq + 1
       RETURNING last_seq`,
      [year],
    );
    return `INV-DIF-${year}-${String(res.rows[0].last_seq).padStart(5, '0')}`;
  }

  /** Abre un expediente manual sobre una diferencia. */
  async open(dto: OpenInvestigationDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (typeof dto.expected_qty !== 'number' || typeof dto.physical_qty !== 'number')
      throw new BadRequestException('expected_qty/physical_qty requeridos');
    const diff = dto.physical_qty - dto.expected_qty;
    const unitCost = Number(dto.unit_cost) || 0;
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const folio = await this.nextFolio(trx);
      const [row] = await trx('commercial.inventory_investigations')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio,
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          expected_qty: dto.expected_qty,
          physical_qty: dto.physical_qty,
          difference: diff,
          unit_cost: unitCost,
          value_at_cost: diff * unitCost,
          reason_code: dto.reason_code || null,
          resolution_notes: dto.notes || null,
          status: 'open',
          opened_by: userId,
        })
        .returning('*');
      return row;
    });
  }

  /**
   * Genera expedientes desde un folio de conteo RECONCILIADO: un expediente por item
   * con varianza ≠ 0 que aún no tenga uno. Idempotente (índice único por source_item_id).
   */
  async fromCount(countRef: string) {
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const count = await trx('commercial.inventory_counts')
        .where((qb: any) => (UUID.test(countRef) ? qb.where('id', countRef) : qb.where('folio', countRef)))
        .first();
      if (!count) throw new NotFoundException('Folio de conteo no encontrado');

      const items = await trx('commercial.inventory_count_items')
        .where({ count_id: count.id })
        .whereNotNull('variance')
        .whereRaw('variance <> 0');

      let created = 0;
      const folios: string[] = [];
      for (const it of items) {
        const exists = await trx('commercial.inventory_investigations').where({ source_item_id: it.id }).first('id');
        if (exists) continue;
        const diff = Number(it.variance);
        const unitCost = Number(it.unit_cost) || 0;
        const expected = Number(it.expected_qty) || 0;
        const folio = await this.nextFolio(trx);
        await trx('commercial.inventory_investigations').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio,
          warehouse_id: count.warehouse_id,
          product_id: it.product_id,
          source_count_id: count.id,
          source_item_id: it.id,
          expected_qty: expected,
          physical_qty: expected + diff,
          difference: diff,
          unit_cost: unitCost,
          value_at_cost: diff * unitCost,
          reason_code: it.reason_code || null,
          status: 'open',
          opened_by: userId,
        });
        created++;
        folios.push(folio);
      }
      return { count_folio: count.folio, created, folios };
    });
  }

  async list(query: { status?: string; warehouse_id?: string; product_id?: string; limit?: number }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));
    return this.tk.run(async (trx) => {
      let q = trx('commercial.inventory_investigations as i')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'i.tenant_id').andOn('w.id', '=', 'i.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'i.product_id');
      if (query.status) q = q.where('i.status', query.status);
      if (query.warehouse_id) q = q.where('i.warehouse_id', query.warehouse_id);
      if (query.product_id) q = q.where('i.product_id', query.product_id);
      return q
        .select(
          'i.id', 'i.folio', 'i.warehouse_id', 'w.code as warehouse_code',
          'i.product_id', 'p.sku', 'p.nombre as product_name',
          'i.expected_qty', 'i.physical_qty', 'i.difference', 'i.value_at_cost',
          'i.status', 'i.root_cause', 'i.reason_code', 'i.opened_at', 'i.resolved_at',
        )
        .orderByRaw(`CASE i.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 WHEN 'monitoring' THEN 2 ELSE 3 END`)
        .orderBy('i.opened_at', 'desc')
        .limit(limit);
    });
  }

  async detail(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const inv = await trx('commercial.inventory_investigations as i')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'i.tenant_id').andOn('w.id', '=', 'i.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .where('i.id', id)
        .select('i.*', 'w.code as warehouse_code', 'w.name as warehouse_name', 'p.sku', 'p.nombre as product_name')
        .first();
      if (!inv) throw new NotFoundException('Expediente no encontrado');
      const timeline = await this.buildTimeline(trx, inv.warehouse_id, inv.product_id);
      return { ...inv, timeline };
    });
  }

  /** Línea de tiempo del SKU (standalone). */
  async skuTimeline(warehouseId: string, productId: string) {
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(productId)) throw new BadRequestException('product_id inválido');
    return this.tk.run((trx) => this.buildTimeline(trx, warehouseId, productId));
  }

  /**
   * Une la bitácora app-nativa (commercial.stock_movements, con RLS) y el diario ERP
   * (analytics.stock_movements, sin RLS → filtro tenant explícito, best-effort) en una
   * sola línea de tiempo cronológica por (almacén, producto).
   */
  private async buildTimeline(trx: any, warehouseId: string, productId: string) {
    const tenantId = this.tenantCtx.get()?.tenantId || null;

    const app = await trx('commercial.stock_movements')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .select('created_at', 'movement_type', 'quantity', 'quantity_before', 'quantity_after', 'reference_type', 'reference_id', 'notes')
      .orderBy('created_at', 'desc')
      .limit(200);

    const appRows = app.map((m: any) => {
      const before = m.quantity_before != null ? Number(m.quantity_before) : null;
      const after = m.quantity_after != null ? Number(m.quantity_after) : null;
      let signed: number | null = before != null && after != null ? after - before : null;
      if (signed == null) {
        const q = Number(m.quantity);
        signed = ['out', 'sale'].includes(m.movement_type) ? -q : ['in'].includes(m.movement_type) ? q : null;
      }
      return {
        source: 'app',
        ts: m.created_at,
        kind: MOVEMENT_LABELS[m.movement_type] || m.movement_type,
        signed_qty: signed,
        quantity: Number(m.quantity),
        quantity_after: after,
        reference_type: m.reference_type,
        reference_id: m.reference_id,
        folio: null,
        detail: m.notes || null,
      };
    });

    // ERP (best-effort: si el feed no está, no rompe el expediente).
    let erpRows: any[] = [];
    try {
      const erp = await trx('analytics.stock_movements')
        .where({ tenant_id: tenantId, warehouse_id: warehouseId, product_id: productId })
        .select('doc_date', 'movement_label', 'movement_kind', 'signed_qty', 'qty', 'folio', 'doc_code', 'source_branch', 'dest_label')
        .orderBy('doc_date', 'desc')
        .limit(200);
      erpRows = erp.map((m: any) => ({
        source: 'erp',
        ts: m.doc_date,
        kind: m.movement_label || (m.movement_kind === 'entrada' ? 'Entrada' : 'Salida'),
        signed_qty: m.signed_qty != null ? Number(m.signed_qty) : null,
        quantity: Number(m.qty),
        quantity_after: null,
        reference_type: m.doc_code || null,
        reference_id: null,
        folio: m.folio || null,
        detail: m.dest_label || m.source_branch || null,
      }));
    } catch (e: any) {
      this.logger.warn(`timeline ERP omitido: ${e?.message || e}`);
    }

    return [...appRows, ...erpRows]
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, 300);
  }

  /** Clasifica la causa raíz (pasa a investigating). */
  async classify(id: string, rootCause: string, notes?: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    if (!ROOT_CAUSES.includes(rootCause)) throw new BadRequestException(`root_cause debe ser uno de: ${ROOT_CAUSES.join(', ')}`);
    return this.tk.run(async (trx) => {
      const inv = await trx('commercial.inventory_investigations').where({ id }).first();
      if (!inv) throw new NotFoundException('Expediente no encontrado');
      if (inv.status === 'resolved') throw new ConflictException('El expediente ya está resuelto');
      await trx('commercial.inventory_investigations').where({ id }).update({
        root_cause: rootCause,
        status: 'investigating',
        resolution_notes: notes != null ? notes : inv.resolution_notes,
        updated_at: trx.fn.now(),
      });
      return this.detail(id);
    });
  }

  /** Cierra el expediente con causa + notas (+ liga el ajuste, nunca huérfano). */
  async resolve(id: string, dto: { root_cause?: string; resolution_notes?: string; adjustment_movement_id?: string }) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    if (dto.root_cause && !ROOT_CAUSES.includes(dto.root_cause)) throw new BadRequestException('root_cause inválido');
    if (dto.adjustment_movement_id && !UUID.test(dto.adjustment_movement_id)) throw new BadRequestException('adjustment_movement_id inválido');
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const inv = await trx('commercial.inventory_investigations').where({ id }).first();
      if (!inv) throw new NotFoundException('Expediente no encontrado');
      if (inv.status === 'resolved') throw new ConflictException('El expediente ya está resuelto');
      const rootCause = dto.root_cause || inv.root_cause;
      if (!rootCause) throw new BadRequestException('Se requiere clasificar la causa raíz antes de resolver');
      await trx('commercial.inventory_investigations').where({ id }).update({
        root_cause: rootCause,
        status: 'resolved',
        resolution_notes: dto.resolution_notes != null ? dto.resolution_notes : inv.resolution_notes,
        adjustment_movement_id: dto.adjustment_movement_id || inv.adjustment_movement_id || null,
        resolved_by: userId,
        resolved_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      return this.detail(id);
    });
  }

  /** Pérdida no identificada → monitoreo intensivo (hook PREV.2). */
  async toMonitoring(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const inv = await trx('commercial.inventory_investigations').where({ id }).first();
      if (!inv) throw new NotFoundException('Expediente no encontrado');
      await trx('commercial.inventory_investigations').where({ id }).update({
        status: 'monitoring',
        root_cause: inv.root_cause || 'PNI',
        updated_at: trx.fn.now(),
      });
      return this.detail(id);
    });
  }
}
