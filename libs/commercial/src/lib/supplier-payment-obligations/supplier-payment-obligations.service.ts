import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

export interface CreateSupplierObligationDto {
  supplier_id: string;
  purchase_order_id?: string | null;
  goods_receipt_id?: string | null;
  invoice_folio?: string | null;
  concept?: string | null;
  original_amount: number;
  original_due_date?: string | null;
  negotiated_date?: string | null;
  notes?: string | null;
}

/**
 * Fase TP.1 — Compras: obligaciones a proveedor de mercancía (ADR-064). La "cuenta por pagar"
 * que RA.15 no modela (esa cadena trackea unidades/costo pactado, no saldo con vencimiento
 * negociable). Opcionalmente ligada a `purchase_orders`/`goods_receipts`. El Calendario de Pagos
 * de Finanzas SOLO lee de acá.
 */
@Injectable()
export class SupplierPaymentObligationsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(q: { status?: string; search?: string; dueFrom?: string; dueTo?: string; supplier_id?: string; onlyCritical?: boolean }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('commercial.supplier_payment_obligations as o')
        .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
        .select('o.*', 's.name as supplier_name', 's.code as supplier_code', 's.is_critical as supplier_critical', 's.critical_reason as supplier_critical_reason',
          trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'));
      if (q.status) b.where('o.status', q.status); else b.whereNotIn('o.status', ['cancelled']);
      if (q.supplier_id) b.where('o.supplier_id', q.supplier_id);
      if (q.onlyCritical) b.where('s.is_critical', true);
      if (q.search?.trim()) b.andWhere((w) => w.whereILike('s.name', `%${q.search!.trim()}%`).orWhereILike('o.invoice_folio', `%${q.search!.trim()}%`).orWhereILike('o.concept', `%${q.search!.trim()}%`));
      if (q.dueFrom) b.where('o.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) b.where('o.original_due_date', '<=', q.dueTo);
      return b.orderByRaw('o.original_due_date ASC NULLS LAST');
    });
  }

  async get(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('commercial.supplier_payment_obligations').where({ id }).first());
    if (!row) throw new NotFoundException('Obligación a proveedor no encontrada');
    return row;
  }

  async create(dto: CreateSupplierObligationDto, username: string) {
    if (!dto.supplier_id) throw new BadRequestException('supplier_id es requerido');
    if (!(Number(dto.original_amount) > 0)) throw new BadRequestException('original_amount debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const supplier = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: dto.supplier_id }).first();
      if (!supplier) throw new NotFoundException('Proveedor no encontrado');
      const [row] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: tenantId,
        supplier_id: dto.supplier_id,
        purchase_order_id: dto.purchase_order_id ?? null,
        goods_receipt_id: dto.goods_receipt_id ?? null,
        invoice_folio: dto.invoice_folio ?? null,
        concept: dto.concept ?? null,
        original_amount: dto.original_amount,
        original_due_date: dto.original_due_date ?? null,
        negotiated_date: dto.negotiated_date ?? null,
        notes: dto.notes ?? null,
        authorized_by: username,
        created_by: username,
      }).returning('*');
      return row;
    });
  }

  async cancel(id: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id }).first();
      if (!row) throw new NotFoundException('Obligación a proveedor no encontrada');
      if (Number(row.reserved_amount) > 0 || Number(row.paid_amount) > 0) {
        throw new BadRequestException('No se puede cancelar: tiene pagos reservados o ejecutados. Reprograma/cancela esos pagos primero.');
      }
      const [updated] = await trx('commercial.supplier_payment_obligations').where({ tenant_id: tenantId, id })
        .update({ status: 'cancelled', notes: reason ? `${row.notes ?? ''}\n[cancelado] ${reason}`.trim() : row.notes, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return updated;
    });
  }

  /** Búsqueda ligera de proveedores para el selector de la obligación nueva. */
  async searchSuppliers(search?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('catalog.suppliers').select('id', 'name', 'code', 'is_critical', 'critical_reason').where('activo', true);
      if (search?.trim()) b.andWhereILike('name', `%${search.trim()}%`);
      return b.orderBy('name').limit(50);
    });
  }

  /**
   * Marca/desmarca un proveedor como crítico, SIEMPRE con motivo — nunca se infiere del importe
   * (regla explícita del pedido). Vive acá (no en `commercial-replenishment.service.ts`, código
   * vivo de RA en producción) para no arriesgar ese archivo bajo este cambio.
   */
  async setSupplierCritical(supplierId: string, isCritical: boolean, reason: string | undefined, username: string) {
    if (isCritical && !reason?.trim()) throw new BadRequestException('Marcar un proveedor como crítico requiere un motivo');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // NOTA: catalog.suppliers.updated_by es uuid (no texto) — no se toca desde acá, donde
      // solo tenemos el username. El motivo queda igual en critical_reason (auditable).
      const n = await trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId })
        .update({ is_critical: isCritical, critical_reason: isCritical ? reason!.trim() : null, updated_at: trx.fn.now() });
      if (!n) throw new NotFoundException('Proveedor no encontrado');
      return trx('catalog.suppliers').where({ tenant_id: tenantId, id: supplierId }).select('id', 'name', 'is_critical', 'critical_reason').first();
    });
  }
}
