import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

export interface CreateFinancialCommitmentDto {
  concept: string;
  beneficiary: string;
  subtype: 'factoraje' | 'interes' | 'amortizacion' | 'otro';
  bank_account_id?: string | null;
  original_amount: number;
  original_due_date?: string | null;
  negotiated_date?: string | null;
  is_critical?: boolean;
  critical_reason?: string | null;
  notes?: string | null;
}

/**
 * Fase TP.1 — Finanzas: compromisos financieros de deuda (factoraje/interés/amortización,
 * ADR-064). Mismo contrato que `budget.expense_obligations`, tabla separada (Finanzas es
 * responsable distinto de Presupuestos). Reusa el permiso FINANCE_PAYMENTS_* (ya es el permiso
 * "pagos" de Finanzas).
 */
@Injectable()
export class FinancialCommitmentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(q: { status?: string; search?: string; dueFrom?: string; dueTo?: string; subtype?: string }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('finance.financial_commitments as o').select('o.*',
        trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'));
      if (q.status) b.where('o.status', q.status); else b.whereNotIn('o.status', ['cancelled']);
      if (q.subtype) b.where('o.subtype', q.subtype);
      if (q.search?.trim()) b.andWhere((w) => w.whereILike('o.beneficiary', `%${q.search!.trim()}%`).orWhereILike('o.concept', `%${q.search!.trim()}%`));
      if (q.dueFrom) b.where('o.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) b.where('o.original_due_date', '<=', q.dueTo);
      return b.orderByRaw('o.original_due_date ASC NULLS LAST');
    });
  }

  async get(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('finance.financial_commitments').where({ id }).first());
    if (!row) throw new NotFoundException('Compromiso financiero no encontrado');
    return row;
  }

  async create(dto: CreateFinancialCommitmentDto, username: string) {
    if (!dto.concept?.trim()) throw new BadRequestException('concept es requerido');
    if (!dto.beneficiary?.trim()) throw new BadRequestException('beneficiary es requerido');
    if (!['factoraje', 'interes', 'amortizacion', 'otro'].includes(dto.subtype)) throw new BadRequestException('subtype inválido');
    if (!(Number(dto.original_amount) > 0)) throw new BadRequestException('original_amount debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.financial_commitments').insert({
        tenant_id: tenantId,
        concept: dto.concept.trim(),
        beneficiary: dto.beneficiary.trim(),
        subtype: dto.subtype,
        bank_account_id: dto.bank_account_id ?? null,
        original_amount: dto.original_amount,
        original_due_date: dto.original_due_date ?? null,
        negotiated_date: dto.negotiated_date ?? null,
        is_critical: !!dto.is_critical,
        critical_reason: dto.critical_reason ?? null,
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
      const row = await trx('finance.financial_commitments').where({ tenant_id: tenantId, id }).first();
      if (!row) throw new NotFoundException('Compromiso financiero no encontrado');
      if (Number(row.reserved_amount) > 0 || Number(row.paid_amount) > 0) {
        throw new BadRequestException('No se puede cancelar: tiene pagos reservados o ejecutados. Reprograma/cancela esos pagos primero.');
      }
      const [updated] = await trx('finance.financial_commitments').where({ tenant_id: tenantId, id })
        .update({ status: 'cancelled', notes: reason ? `${row.notes ?? ''}\n[cancelado] ${reason}`.trim() : row.notes, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return updated;
    });
  }
}
