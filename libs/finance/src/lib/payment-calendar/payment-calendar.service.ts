import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

export type ObligationSource = 'budget_expense' | 'financial_commitment' | 'supplier_payable';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

const TABLE_BY_SOURCE: Record<ObligationSource, string> = {
  budget_expense: 'budget.expense_obligations',
  financial_commitment: 'finance.financial_commitments',
  supplier_payable: 'commercial.supplier_payment_obligations',
};
const CLASSIFICATION_BY_SOURCE: Record<ObligationSource, string> = {
  budget_expense: 'gasto',
  financial_commitment: 'compromiso_financiero',
  supplier_payable: 'proveedor_mercancia',
};

export interface AllocationItemDto { obligation_source: ObligationSource; obligation_id: string; applied_amount: number }
export interface CreateAllocationDto { date: string; items: AllocationItemDto[]; priority_rank?: number | null; notes?: string | null }
export interface PrepareAllocationDto {
  payment_method: 'transferencia' | 'cheque' | 'efectivo' | 'cargo_automatico';
  bank_account_id?: string | null; destination_account_text?: string | null;
  cash_register_text?: string | null; reference_text?: string | null;
  supplier_payment_account_id?: string | null;
}
export type ReprogramReason = 'cuenta_erronea' | 'falla_sistema_banco' | 'pago_devuelto' | 'presupuesto_recortado' | 'otro';
export const REPROGRAM_REASONS: ReprogramReason[] = ['cuenta_erronea', 'falla_sistema_banco', 'pago_devuelto', 'presupuesto_recortado', 'otro'];
// TP.6 — un lote AUTORIZADO (o más adelante) ya cerró su alcance: no admite nuevos pagos.
// Reprogramar/fallar/ejecutar una allocation EXISTENTE sigue permitido (son hechos de ejecución,
// no de autorización) — lo que se bloquea es agregar pagos NUEVOS al lote ya autorizado.
const LOCKED_LOT_STATUSES = new Set(['released', 'executing', 'closed']);
export interface CreateAgreementDto {
  obligation_source: ObligationSource; obligation_id: string;
  responsible_user?: string | null; counterpart_text?: string | null;
  committed_date?: string | null; committed_amount?: number | null;
  allows_partial?: boolean; evidence_url?: string | null; notes?: string | null;
}

/**
 * Fase TP.1 — El motor de asignación del Calendario de Pagos (ADR-064). SOLO LEE las tres tablas
 * de origen (`budget.expense_obligations` / `finance.financial_commitments` /
 * `commercial.supplier_payment_obligations`) — nunca las crea. Reserva por `payment_allocations`
 * + `payment_allocation_items` (polimórfico), y mantiene `reserved_amount`/`paid_amount`/`status`
 * de cada obligación SIEMPRE recalculados desde los items activos (nunca +=/-= manual, para no
 * desincronizar el saldo).
 */
@Injectable()
export class PaymentCalendarService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private assertDate(d: string) {
    if (!DATE_RX.test(d)) throw new BadRequestException('Fecha inválida (YYYY-MM-DD)');
  }

  /** Recalcula reserved_amount/paid_amount/status de UNA obligación desde sus items activos. */
  private async recalcObligation(trx: any, source: ObligationSource, id: string) {
    const table = TABLE_BY_SOURCE[source];
    const [agg] = await trx('finance.payment_allocation_items as i')
      .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
      .where({ 'i.obligation_source': source, 'i.obligation_id': id })
      .select(
        trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
        trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
      );
    const row = await trx(table).select('original_amount', 'status').where({ id }).first();
    if (!row) return;
    const reserved = Number(agg?.reserved ?? 0);
    const paid = Number(agg?.paid ?? 0);
    const newStatus = row.status === 'cancelled' ? 'cancelled'
      : paid >= Number(row.original_amount) ? 'paid'
      : (paid > 0 || reserved > 0) ? 'partial' : 'pending';
    await trx(table).where({ id }).update({ reserved_amount: reserved, paid_amount: paid, status: newStatus, updated_at: trx.fn.now() });
  }

  /** Recalcula amount_assigned de UN allocation desde sus items. */
  private async recalcAllocationTotal(trx: any, allocationId: string) {
    const [{ total }] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).sum({ total: 'applied_amount' });
    await trx('finance.payment_allocations').where({ id: allocationId }).update({ amount_assigned: total ?? 0, updated_at: trx.fn.now() });
  }

  private async getOrCreateLot(trx: any, tenantId: string, date: string) {
    let lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
    if (!lot) [lot] = await trx('finance.payment_calendar_lots').insert({ tenant_id: tenantId, lot_date: date }).returning('*');
    return lot;
  }

  // ── Obligaciones disponibles (UNION de los 3 orígenes; nunca escribe) ────────────────
  async listObligations(q: {
    source?: ObligationSource; classification?: string; search?: string;
    dueFrom?: string; dueTo?: string; onlyCritical?: boolean; onlyAvailable?: boolean;
  }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const cols = [
        'obligation_source', 'obligation_id', 'beneficiary', 'concept', 'classification', 'subtype',
        'area_code', 'original_due_date', 'negotiated_date', 'original_amount', 'reserved_amount',
        'paid_amount', 'available_amount', 'is_critical', 'critical_reason', 'authorized_by',
        'authorized_at', 'status', 'notes', 'created_at',
      ];
      const legBudget = trx('budget.expense_obligations as o').select(
        trx.raw(`'budget_expense'::text AS obligation_source`), 'o.id AS obligation_id',
        'o.beneficiary', 'o.concept', trx.raw(`'gasto'::text AS classification`), 'o.subtype',
        'o.area AS area_code', 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
        'o.reserved_amount', 'o.paid_amount',
        trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.is_critical', 'o.critical_reason', 'o.authorized_by', 'o.authorized_at', 'o.status', 'o.notes', 'o.created_at',
      ).whereNotIn('o.status', ['cancelled']);

      const legCommitment = trx('finance.financial_commitments as o').select(
        trx.raw(`'financial_commitment'::text AS obligation_source`), 'o.id AS obligation_id',
        'o.beneficiary', 'o.concept', trx.raw(`'compromiso_financiero'::text AS classification`), 'o.subtype',
        trx.raw('NULL::text AS area_code'), 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
        'o.reserved_amount', 'o.paid_amount',
        trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.is_critical', 'o.critical_reason', 'o.authorized_by', 'o.authorized_at', 'o.status', 'o.notes', 'o.created_at',
      ).whereNotIn('o.status', ['cancelled']);

      const legSupplier = trx('commercial.supplier_payment_obligations as o')
        .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
        .select(
          trx.raw(`'supplier_payable'::text AS obligation_source`), 'o.id AS obligation_id',
          's.name AS beneficiary', trx.raw(`coalesce(o.concept, o.invoice_folio, 'Mercancía')::text AS concept`),
          trx.raw(`'proveedor_mercancia'::text AS classification`), trx.raw(`'mercancia'::text AS subtype`),
          's.code AS area_code', 'o.original_due_date', 'o.negotiated_date', 'o.original_amount',
          'o.reserved_amount', 'o.paid_amount',
          trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
          's.is_critical', 's.critical_reason', 'o.authorized_by', 'o.authorized_at', 'o.status', 'o.notes', 'o.created_at',
        ).whereNotIn('o.status', ['cancelled']);

      const unionSql = `(${legBudget.toQuery()} UNION ALL ${legCommitment.toQuery()} UNION ALL ${legSupplier.toQuery()}) AS ob`;
      const base = trx.select(cols.map((c) => `ob.${c}`)).from(trx.raw(unionSql));
      if (q.source) base.where('ob.obligation_source', q.source);
      if (q.classification) base.where('ob.classification', q.classification);
      if (q.onlyCritical) base.where('ob.is_critical', true);
      if (q.search?.trim()) {
        const s = q.search.trim();
        base.andWhere((w: any) => w.whereILike('ob.beneficiary', `%${s}%`).orWhereILike('ob.concept', `%${s}%`));
      }
      if (q.dueFrom) base.where('ob.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) base.where('ob.original_due_date', '<=', q.dueTo);
      if (q.onlyAvailable !== false) base.where('ob.available_amount', '>', 0).whereIn('ob.status', ['pending', 'partial']);
      return base.orderByRaw('ob.original_due_date ASC NULLS LAST, ob.available_amount DESC').limit(1000);
    });
  }

  // ── Resumen del día (capacidad + asignado + restante + ejecutado + pendiente) ────────
  async daySummary(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const capacity = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: date }).first();
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      let assigned = 0, executed = 0;
      if (lot) {
        const rows = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed'])
          .select('status').sum({ monto: 'amount_assigned' }).groupBy('status');
        for (const r of rows as any[]) {
          const m = Number(r.monto);
          assigned += m;
          if (r.status === 'executed') executed += m;
        }
      }
      const authorized = capacity ? Number(capacity.authorized_amount) : null;
      return {
        date,
        capacity_defined: !!capacity,
        authorized_amount: authorized,
        assigned_amount: assigned,
        remaining_amount: authorized == null ? null : authorized - assigned,
        executed_amount: executed,
        pending_execution_amount: assigned - executed,
        exceeded: authorized != null && assigned > authorized,
        lot_status: lot?.status ?? null,
      };
    });
  }

  // ── Pagos del día (con sus documentos resueltos a beneficiario/concepto) ─────────────
  async listDayAllocations(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) return [];
      const allocations = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereNot('status', 'cancelled')
        .orderByRaw('priority_rank ASC NULLS LAST').orderBy('created_at', 'asc');
      if (!allocations.length) return [];
      const items = await trx('finance.payment_allocation_items').whereIn('allocation_id', allocations.map((a: any) => a.id));
      const bySource: Record<string, string[]> = {};
      for (const it of items as any[]) (bySource[it.obligation_source] ??= []).push(it.obligation_id);
      const labels = new Map<string, { beneficiary: string; concept: string; supplier_id?: string }>();
      for (const source of Object.keys(bySource) as ObligationSource[]) {
        const ids = bySource[source];
        if (source === 'supplier_payable') {
          const rows = await trx('commercial.supplier_payment_obligations as o')
            .join('catalog.suppliers as s', 's.id', 'o.supplier_id')
            .whereIn('o.id', ids)
            .select('o.id', 's.name as beneficiary', 'o.supplier_id', trx.raw("coalesce(o.concept, o.invoice_folio, 'Mercancía') as concept"));
          for (const r of rows as any[]) labels.set(`${source}:${r.id}`, { beneficiary: r.beneficiary, concept: r.concept, supplier_id: r.supplier_id });
        } else {
          const rows = await trx(TABLE_BY_SOURCE[source]).whereIn('id', ids).select('id', 'beneficiary', 'concept');
          for (const r of rows as any[]) labels.set(`${source}:${r.id}`, { beneficiary: r.beneficiary, concept: r.concept ?? '—' });
        }
      }
      const itemsByAllocation = new Map<string, any[]>();
      for (const it of items as any[]) {
        const label = labels.get(`${it.obligation_source}:${it.obligation_id}`);
        const arr = itemsByAllocation.get(it.allocation_id) ?? [];
        arr.push({ ...it, beneficiary: label?.beneficiary ?? '—', concept: label?.concept ?? '—', supplier_id: label?.supplier_id ?? null });
        itemsByAllocation.set(it.allocation_id, arr);
      }
      return allocations.map((a: any) => ({ ...a, items: itemsByAllocation.get(a.id) ?? [] }));
    });
  }

  /** El lote del día tal cual (folio/status/released_by/at) — usado por el documento imprimible. */
  async getLot(date: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first());
  }

  // ── Crear un pago (fecha + monto; SIN método/banco — criterio #4) ────────────────────
  async createAllocation(dto: CreateAllocationDto, username: string) {
    this.assertDate(dto.date);
    if (!dto.items?.length) throw new BadRequestException('Se requiere al menos una obligación');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const classifications = new Set<string>();
      for (const it of dto.items) {
        if (!(Number(it.applied_amount) > 0)) throw new BadRequestException('applied_amount debe ser > 0');
        const table = TABLE_BY_SOURCE[it.obligation_source];
        if (!table) throw new BadRequestException('obligation_source inválido');
        const row = await trx(table).where({ tenant_id: tenantId, id: it.obligation_id }).first();
        if (!row) throw new NotFoundException(`Obligación ${it.obligation_id} no encontrada`);
        if (row.status === 'cancelled') throw new BadRequestException('La obligación está cancelada');
        const available = Number(row.original_amount) - Number(row.reserved_amount) - Number(row.paid_amount);
        if (Number(it.applied_amount) > available + 0.005) throw new BadRequestException(`Excede el saldo disponible de la obligación (disponible: ${available.toFixed(2)})`);
        classifications.add(CLASSIFICATION_BY_SOURCE[it.obligation_source]);
      }
      if (classifications.size > 1) throw new BadRequestException('Un mismo pago no puede mezclar clasificaciones distintas (compromiso financiero / gasto / proveedor) — crea pagos separados.');
      const lot = await this.getOrCreateLot(trx, tenantId, dto.date);
      if (LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día ya fue autorizado/cerrado — no admite pagos nuevos (reprograma a otro día).');
      const amountAssigned = dto.items.reduce((s, it) => s + Number(it.applied_amount), 0);
      const [allocation] = await trx('finance.payment_allocations').insert({
        tenant_id: tenantId, lot_id: lot.id, classification: [...classifications][0],
        priority_rank: dto.priority_rank ?? null, amount_assigned: amountAssigned,
        notes: dto.notes ?? null, created_by: username,
      }).returning('*');
      for (const it of dto.items) {
        await trx('finance.payment_allocation_items').insert({
          tenant_id: tenantId, allocation_id: allocation.id, obligation_source: it.obligation_source,
          obligation_id: it.obligation_id, applied_amount: it.applied_amount,
        });
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      }
      return allocation;
    });
  }

  async addItem(allocationId: string, item: AllocationItemDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      if (CLASSIFICATION_BY_SOURCE[item.obligation_source] !== allocation.classification) throw new BadRequestException('La obligación no coincide con la clasificación de este pago');
      const table = TABLE_BY_SOURCE[item.obligation_source];
      const row = await trx(table).where({ tenant_id: tenantId, id: item.obligation_id }).first();
      if (!row) throw new NotFoundException('Obligación no encontrada');
      const available = Number(row.original_amount) - Number(row.reserved_amount) - Number(row.paid_amount);
      if (Number(item.applied_amount) > available + 0.005) throw new BadRequestException(`Excede el saldo disponible de la obligación (disponible: ${available.toFixed(2)})`);
      await trx('finance.payment_allocation_items').insert({
        tenant_id: tenantId, allocation_id: allocationId, obligation_source: item.obligation_source,
        obligation_id: item.obligation_id, applied_amount: item.applied_amount,
      });
      await this.recalcObligation(trx, item.obligation_source, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      void username;
      return trx('finance.payment_allocations').where({ id: allocationId }).first();
    });
  }

  async removeItem(allocationId: string, itemId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const item = await trx('finance.payment_allocation_items').where({ tenant_id: tenantId, id: itemId, allocation_id: allocationId }).first();
      if (!item) throw new NotFoundException('Documento no encontrado en este pago');
      const allocation = await trx('finance.payment_allocations').where({ id: allocationId }).first();
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede modificar un pago pendiente');
      const [{ count }] = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).whereNot('id', itemId).count();
      if (Number(count) === 0) throw new BadRequestException('Un pago debe tener al menos un documento — cancela el pago en vez de vaciarlo');
      await trx('finance.payment_allocation_items').where({ id: itemId }).del();
      await this.recalcObligation(trx, item.obligation_source, item.obligation_id);
      await this.recalcAllocationTotal(trx, allocationId);
      return { ok: true };
    });
  }

  /**
   * Reprograma: cancela el pago actual (libera el día viejo) y crea uno nuevo en la fecha nueva.
   * TP.10 — exige motivo (cerrado + 'otro' con detalle libre): permite reprogramar un pago
   * PENDIENTE (ej. presupuesto recortado) o uno FALLIDO (cuenta errónea/banco/devuelto/otro).
   */
  async reprogram(allocationId: string, newDate: string, reason: ReprogramReason, reasonDetail: string | undefined, username: string) {
    this.assertDate(newDate);
    if (!REPROGRAM_REASONS.includes(reason)) throw new BadRequestException(`reason inválido — debe ser uno de: ${REPROGRAM_REASONS.join(', ')}`);
    if (reason === 'otro' && !reasonDetail?.trim()) throw new BadRequestException('reasonDetail es requerido cuando reason = "otro"');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (!['pending', 'failed'].includes(allocation.status)) throw new BadRequestException('Solo se puede reprogramar un pago pendiente o fallido');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      await trx('finance.payment_allocations').where({ id: allocationId }).update({
        status: 'cancelled', notes: `${allocation.notes ?? ''}\n[reprogramado a ${newDate}]`.trim(),
        reprogram_reason: reason, reprogram_reason_detail: reason === 'otro' ? reasonDetail!.trim() : null,
        updated_by: username, updated_at: trx.fn.now(),
      });
      const lot = await this.getOrCreateLot(trx, tenantId, newDate);
      if (LOCKED_LOT_STATUSES.has(lot.status)) throw new BadRequestException('El día destino ya fue autorizado/cerrado');
      const [newAllocation] = await trx('finance.payment_allocations').insert({
        tenant_id: tenantId, lot_id: lot.id, classification: allocation.classification,
        priority_rank: null, amount_assigned: allocation.amount_assigned,
        notes: allocation.notes, payment_method: allocation.payment_method,
        bank_account_id: allocation.bank_account_id, destination_account_text: allocation.destination_account_text,
        cash_register_text: allocation.cash_register_text, reference_text: allocation.reference_text,
        supplier_payment_account_id: allocation.supplier_payment_account_id,
        reprogrammed_from_id: allocation.id, created_by: username,
      }).returning('*');
      for (const it of items as any[]) {
        await trx('finance.payment_allocation_items').insert({
          tenant_id: tenantId, allocation_id: newAllocation.id, obligation_source: it.obligation_source,
          obligation_id: it.obligation_id, applied_amount: it.applied_amount, agreement_id: it.agreement_id,
        });
        await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      }
      return newAllocation;
    });
  }

  /**
   * Completa el método de pago. `supplier_payment_account_id` (TP.7) referencia el catálogo de
   * cuentas del proveedor en vez de texto libre — evita el error de captura que pidió el usuario;
   * `destination_account_text` se autocompleta como snapshot legible (banco+CLABE) para el
   * documento impreso, pero SIEMPRE puede capturarse a mano para compromisos/gastos sin proveedor.
   */
  async prepare(allocationId: string, dto: PrepareAllocationDto, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['transferencia', 'cheque', 'efectivo', 'cargo_automatico'].includes(dto.payment_method)) throw new BadRequestException('payment_method inválido');
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se prepara un pago pendiente');

      let destinationText = dto.destination_account_text ?? null;
      let accountId = dto.supplier_payment_account_id ?? null;
      if (accountId) {
        const acc = await trx('commercial.supplier_payment_accounts').where({ tenant_id: tenantId, id: accountId, status: 'activa' }).first();
        if (!acc) throw new BadRequestException('La cuenta de pago seleccionada no existe o está inactiva');
        destinationText = `${acc.bank_name}${acc.clabe ? ' · CLABE ' + acc.clabe : ''}${acc.account_number ? ' · Cta ' + acc.account_number : ''}${acc.alias ? ' (' + acc.alias + ')' : ''}`;
      }
      if ((dto.payment_method === 'transferencia' || dto.payment_method === 'cargo_automatico') && !dto.bank_account_id && !destinationText?.trim()) {
        throw new BadRequestException('Transferencia/cargo automático requiere banco o cuenta destino (o elige una cuenta del catálogo)');
      }
      if (dto.payment_method === 'cheque' && !dto.reference_text?.trim()) throw new BadRequestException('Cheque requiere folio/referencia');
      if (dto.payment_method === 'efectivo' && !dto.cash_register_text?.trim()) throw new BadRequestException('Efectivo requiere la caja de salida');

      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId }).update({
        payment_method: dto.payment_method, bank_account_id: dto.bank_account_id ?? null,
        destination_account_text: destinationText, cash_register_text: dto.cash_register_text ?? null,
        reference_text: dto.reference_text ?? null, supplier_payment_account_id: accountId,
        updated_by: username, updated_at: trx.fn.now(),
      }).returning('*');
      return updated;
    });
  }

  async execute(allocationId: string, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se ejecuta un pago pendiente');
      if (!allocation.payment_method) throw new BadRequestException('Falta preparar el método de pago antes de ejecutar (Caja General lo necesita)');
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ status: 'executed', executed_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now() }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      for (const it of items as any[]) await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      return updated;
    });
  }

  async fail(allocationId: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se marca como fallido un pago pendiente (uno ejecutado no se revierte acá)');
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ status: 'failed', failure_reason: reason ?? null, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      for (const it of items as any[]) await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      return updated;
    });
  }

  async cancelAllocation(allocationId: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se puede cancelar un pago pendiente');
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId }).update({
        status: 'cancelled', notes: reason ? `${allocation.notes ?? ''}\n[cancelado] ${reason}`.trim() : allocation.notes,
        updated_by: username, updated_at: trx.fn.now(),
      }).returning('*');
      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocationId });
      for (const it of items as any[]) await this.recalcObligation(trx, it.obligation_source, it.obligation_id);
      return updated;
    });
  }

  /**
   * TP.6 — propone el orden de pago del día (compromisos financieros → críticos → resto,
   * como ya diseña el motor). Sólo SUGIERE — Tesorería ajusta con `setPriorityRank` antes de
   * autorizar; `releaseLot` exige que todo pago pendiente tenga un orden antes de liberar.
   */
  async suggestPriorityOrder(date: string, username: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) return [];
      const rows = await trx.raw(`
        WITH crit AS (
          SELECT a.id AS allocation_id,
            bool_or(CASE i.obligation_source
              WHEN 'budget_expense' THEN eo.is_critical
              WHEN 'financial_commitment' THEN fc.is_critical
              WHEN 'supplier_payable' THEN s.is_critical END) AS any_critical,
            min(CASE i.obligation_source
              WHEN 'budget_expense' THEN eo.original_due_date
              WHEN 'financial_commitment' THEN fc.original_due_date
              WHEN 'supplier_payable' THEN spo.original_due_date END) AS min_due
          FROM finance.payment_allocations a
          JOIN finance.payment_allocation_items i ON i.allocation_id = a.id
          LEFT JOIN budget.expense_obligations eo ON i.obligation_source='budget_expense' AND eo.id=i.obligation_id
          LEFT JOIN finance.financial_commitments fc ON i.obligation_source='financial_commitment' AND fc.id=i.obligation_id
          LEFT JOIN commercial.supplier_payment_obligations spo ON i.obligation_source='supplier_payable' AND spo.id=i.obligation_id
          LEFT JOIN catalog.suppliers s ON spo.supplier_id = s.id
          WHERE a.lot_id = ? AND a.status = 'pending'
          GROUP BY a.id
        )
        SELECT a.id, a.classification, coalesce(c.any_critical,false) AS any_critical, c.min_due, a.amount_assigned
        FROM finance.payment_allocations a JOIN crit c ON c.allocation_id = a.id
        ORDER BY
          CASE a.classification WHEN 'compromiso_financiero' THEN 0 WHEN 'gasto' THEN 1 WHEN 'proveedor_mercancia' THEN 2 ELSE 3 END,
          c.any_critical DESC,
          c.min_due ASC NULLS LAST,
          a.amount_assigned DESC`, [lot.id]);
      let rank = 1;
      const result: { id: string; priority_rank: number }[] = [];
      for (const r of rows.rows as any[]) {
        await trx('finance.payment_allocations').where({ id: r.id }).update({ priority_rank: rank, updated_by: username, updated_at: trx.fn.now() });
        result.push({ id: r.id, priority_rank: rank });
        rank++;
      }
      return result;
    });
  }

  /** Ajuste manual de Tesorería sobre el orden propuesto (define dónde "cortar" si falta presupuesto). */
  async setPriorityRank(allocationId: string, rank: number, username: string) {
    if (!(Number.isInteger(rank) && rank > 0)) throw new BadRequestException('priority_rank debe ser un entero > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const allocation = await trx('finance.payment_allocations').where({ tenant_id: tenantId, id: allocationId }).first();
      if (!allocation) throw new NotFoundException('Pago no encontrado');
      if (allocation.status !== 'pending') throw new BadRequestException('Solo se reordena un pago pendiente');
      const clash = await trx('finance.payment_allocations').where({ lot_id: allocation.lot_id, priority_rank: rank, status: 'pending' }).whereNot('id', allocationId).first();
      if (clash) throw new BadRequestException(`El orden ${rank} ya lo tiene otro pago de este día`);
      const [updated] = await trx('finance.payment_allocations').where({ id: allocationId })
        .update({ priority_rank: rank, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  /**
   * Libera (AUTORIZA) el lote del día: exige capacidad definida, consumo <= autorizado
   * (criterio #5), y que TODO pago pendiente tenga orden de pago asignado (TP.6). Genera el
   * folio del lote (`YYMMDD-01` — el "01" es el consecutivo de lote del día, hoy siempre 1
   * porque sólo puede haber un lote por día) y el folio de cada pago (`<folio>-NN`, NN = su
   * orden), SOLO en este momento — nunca al crear el borrador (TP.8).
   */
  async releaseLot(date: string, username: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const capacity = await trx('budget.daily_capacity').where({ tenant_id: tenantId, capacity_date: date }).first();
      if (!capacity) throw new BadRequestException('El día no tiene capacidad definida por Presupuestos — no se puede liberar');
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) throw new BadRequestException('No hay pagos asignados este día');
      if (lot.status !== 'draft' && lot.status !== 'scheduled' && lot.status !== 'in_prep') {
        throw new BadRequestException(`El día ya está en estado "${lot.status}" — no se puede volver a liberar`);
      }
      const pending = await trx('finance.payment_allocations').where({ lot_id: lot.id, status: 'pending' });
      const withoutRank = pending.filter((a: any) => a.priority_rank == null);
      if (withoutRank.length) throw new BadRequestException(`${withoutRank.length} pago(s) sin orden de pago asignado — usa "proponer orden" o asígnalo a mano antes de autorizar`);
      const [{ consumo }] = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed'])
        .select(trx.raw('coalesce(sum(amount_assigned),0) AS consumo'));
      if (Number(consumo) > Number(capacity.authorized_amount) + 0.005) {
        throw new BadRequestException(`Excede la capacidad del día (asignado ${Number(consumo).toFixed(2)} > autorizado ${Number(capacity.authorized_amount).toFixed(2)})`);
      }

      const ymd = date.replace(/-/g, '').slice(2); // YYMMDD
      const lotFolio = lot.folio || `${ymd}-01`;
      for (const a of pending as any[]) {
        if (a.folio) continue;
        const folio = `${lotFolio}-${String(a.priority_rank).padStart(2, '0')}`;
        await trx('finance.payment_allocations').where({ id: a.id }).update({ folio, updated_at: trx.fn.now() });
      }
      const [updated] = await trx('finance.payment_calendar_lots').where({ id: lot.id })
        .update({ status: 'released', folio: lotFolio, released_by: username, released_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  async closeLot(date: string, username: string) {
    this.assertDate(date);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: tenantId, lot_date: date }).first();
      if (!lot) throw new NotFoundException('No hay lote este día');
      const [updated] = await trx('finance.payment_calendar_lots').where({ id: lot.id })
        .update({ status: 'closed', closed_by: username, closed_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
      return updated;
    });
  }

  // ── Acuerdos de negociación ───────────────────────────────────────────────────────────
  async listAgreements(source: ObligationSource, obligationId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) =>
      trx('finance.payment_negotiation_agreements').where({ obligation_source: source, obligation_id: obligationId }).orderBy('created_at', 'desc'));
  }

  async createAgreement(dto: CreateAgreementDto, username: string) {
    if (!TABLE_BY_SOURCE[dto.obligation_source]) throw new BadRequestException('obligation_source inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const table = TABLE_BY_SOURCE[dto.obligation_source];
      const row = await trx(table).where({ tenant_id: tenantId, id: dto.obligation_id }).first();
      if (!row) throw new NotFoundException('Obligación no encontrada');
      const [agreement] = await trx('finance.payment_negotiation_agreements').insert({
        tenant_id: tenantId, obligation_source: dto.obligation_source, obligation_id: dto.obligation_id,
        responsible_user: dto.responsible_user ?? username, counterpart_text: dto.counterpart_text ?? null,
        committed_date: dto.committed_date ?? null, committed_amount: dto.committed_amount ?? null,
        allows_partial: !!dto.allows_partial, evidence_url: dto.evidence_url ?? null, notes: dto.notes ?? null,
        created_by: username,
      }).returning('*');
      return agreement;
    });
  }
}
