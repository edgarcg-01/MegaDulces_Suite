import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

export interface CreateExpenseObligationDto {
  concept: string;
  beneficiary: string;
  area?: string | null;
  subtype?: 'luz' | 'renta' | 'sueldos' | 'comisiones' | 'operativo' | 'otro' | null;
  original_amount: number;
  original_due_date?: string | null;
  negotiated_date?: string | null;
  is_critical?: boolean;
  critical_reason?: string | null;
  notes?: string | null;
}

/**
 * Fase TP.1 — Presupuestos: gastos autorizados (obligación de origen, ADR-064). El Calendario de
 * Pagos SOLO lee de acá (nunca escribe); esta es la única puerta de captura, y exige autorización
 * (authorized_by/at NOT NULL) — sin eso, la obligación no puede participar del calendario.
 */
@Injectable()
export class BudgetExpenseObligationsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(q: { status?: string; search?: string; dueFrom?: string; dueTo?: string }) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = trx('budget.expense_obligations as o').select('o.*',
        trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'));
      if (q.status) b.where('o.status', q.status); else b.whereNotIn('o.status', ['cancelled']);
      if (q.search?.trim()) b.andWhere((w) => w.whereILike('o.beneficiary', `%${q.search!.trim()}%`).orWhereILike('o.concept', `%${q.search!.trim()}%`));
      if (q.dueFrom) b.where('o.original_due_date', '>=', q.dueFrom);
      if (q.dueTo) b.where('o.original_due_date', '<=', q.dueTo);
      return b.orderByRaw('o.original_due_date ASC NULLS LAST');
    });
  }

  async get(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('budget.expense_obligations').where({ id }).first());
    if (!row) throw new NotFoundException('Obligación de gasto no encontrada');
    return row;
  }

  async create(dto: CreateExpenseObligationDto, username: string) {
    if (!dto.concept?.trim()) throw new BadRequestException('concept es requerido');
    if (!dto.beneficiary?.trim()) throw new BadRequestException('beneficiary es requerido');
    if (!(Number(dto.original_amount) > 0)) throw new BadRequestException('original_amount debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('budget.expense_obligations').insert({
        tenant_id: tenantId,
        concept: dto.concept.trim(),
        beneficiary: dto.beneficiary.trim(),
        area: dto.area ?? null,
        subtype: dto.subtype ?? null,
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

  // ── PR.3 (ADR-074): auto-generar obligaciones recurrentes del plan de gastos aprobado ────

  /** cuenta_mayor/nombre → subtype (heurístico por nombre; default 'operativo'). */
  private inferSubtype(name: string | null): 'luz' | 'renta' | 'sueldos' | 'comisiones' | 'operativo' {
    const n = (name || '').toLowerCase();
    if (/renta|arrend/.test(n)) return 'renta';
    if (/luz|energ|cfe|electric/.test(n)) return 'luz';
    if (/sueld|n[oó]min|salari|raya/.test(n)) return 'sueldos';
    if (/comis/.test(n)) return 'comisiones';
    return 'operativo';
  }

  private lastDayOfMonth(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${ym}-${String(last).padStart(2, '0')}`;
  }

  /**
   * Genera obligaciones de gasto RECURRENTE (cuentas con ≥6 meses en el plan) del ejercicio, una por
   * cuenta × sucursal × mes, en estado `propuesta` (sin autorizar). Idempotente por source_ref; una
   * propuesta ya existente se actualiza en monto, una ya autorizada NO se toca. Las cuentas esporádicas
   * NO se generan (no son compromisos predecibles). El humano autoriza en lote con `authorize`.
   */
  async generateFromPlan(budgetId: string, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (b.status === 'cerrado') throw new BadRequestException('El presupuesto está cerrado');

      const rows = await trx('budget.expense_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId })
        .select('account_code', 'account_name', 'sucursal', 'year_month', 'monto');
      // agrupar por cuenta × sucursal: meses con monto>0
      const groups = new Map<string, { name: string | null; sucursal: string; months: Array<{ ym: string; monto: number }> }>();
      for (const r of rows) {
        if (!(Number(r.monto) > 0)) continue;
        const key = `${r.account_code}|${r.sucursal || ''}`;
        if (!groups.has(key)) groups.set(key, { name: r.account_name, sucursal: r.sucursal || '', months: [] });
        groups.get(key)!.months.push({ ym: r.year_month, monto: Number(r.monto) });
      }

      const sum = { generated: 0, updated: 0, skipped: 0, accounts_recurrent: 0, accounts_sporadic: 0 };
      for (const [key, g] of groups) {
        if (g.months.length < 6) { sum.accounts_sporadic++; continue; } // solo recurrentes
        sum.accounts_recurrent++;
        const accountCode = key.slice(0, key.indexOf('|'));
        const subtype = this.inferSubtype(g.name);
        for (const m of g.months) {
          const sref = `plan:${budgetId}:${accountCode}:${g.sucursal}:${m.ym}`;
          const existing = await trx('budget.expense_obligations').where({ tenant_id: tenantId, source_ref: sref }).first();
          if (existing) {
            if (existing.status === 'propuesta' && Math.abs(Number(existing.original_amount) - m.monto) >= 0.01) {
              await trx('budget.expense_obligations').where({ tenant_id: tenantId, id: existing.id })
                .update({ original_amount: m.monto, updated_by: username, updated_at: trx.fn.now() });
              sum.updated++;
            } else { sum.skipped++; }
            continue;
          }
          await trx('budget.expense_obligations').insert({
            tenant_id: tenantId,
            concept: `${g.name || accountCode} ${m.ym}`,
            beneficiary: g.name || accountCode,
            area: g.sucursal || null,
            subtype,
            original_amount: m.monto,
            original_due_date: this.lastDayOfMonth(m.ym),
            status: 'propuesta',
            authorized_by: null,
            source: 'plan',
            source_ref: sref,
            created_by: username,
          });
          sum.generated++;
        }
      }
      return sum;
    });
  }

  /** Autoriza en lote las propuestas: propuesta → pending con authorized_by/at (acto humano, HITL). */
  async authorize(ids: string[], username: string) {
    if (!Array.isArray(ids) || !ids.length) throw new BadRequestException('ids vacío');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let authorized = 0, skipped = 0;
      for (const id of ids) {
        const row = await trx('budget.expense_obligations').where({ tenant_id: tenantId, id }).first();
        if (!row || row.status !== 'propuesta') { skipped++; continue; }
        await trx('budget.expense_obligations').where({ tenant_id: tenantId, id })
          .update({ status: 'pending', authorized_by: username, authorized_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now() });
        authorized++;
      }
      return { authorized, skipped };
    });
  }

  async cancel(id: string, reason: string | undefined, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await trx('budget.expense_obligations').where({ tenant_id: tenantId, id }).first();
      if (!row) throw new NotFoundException('Obligación de gasto no encontrada');
      if (Number(row.reserved_amount) > 0 || Number(row.paid_amount) > 0) {
        throw new BadRequestException('No se puede cancelar: tiene pagos reservados o ejecutados. Reprograma/cancela esos pagos primero.');
      }
      const [updated] = await trx('budget.expense_obligations').where({ tenant_id: tenantId, id })
        .update({ status: 'cancelled', notes: reason ? `${row.notes ?? ''}\n[cancelado] ${reason}`.trim() : row.notes, updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return updated;
    });
  }
}
