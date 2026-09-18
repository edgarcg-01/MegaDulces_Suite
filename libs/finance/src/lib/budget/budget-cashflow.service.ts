import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PU.3 — Presupuestos: flujo de efectivo previsto (ADR-066 / ADR-056).
 *
 * Cierra "tener presupuesto ≠ tener liquidez" (spec §1). Proyección semanal:
 *   saldo_proyectado(t) = saldo_inicial + Σ(cobros − pagos) hasta t     (spec §10)
 *
 * Fuentes (lectura/vista, cero importers):
 *   - Saldo inicial  → `finance.bank_movements.running_balance` (última por cuenta, Fase CB).
 *   - Cobros previstos → `analytics.customer_receivables.saldo_documento` por `vencimiento` (Fase CXC, kdue).
 *   - Pagos previstos  → pendiente (original − pagado) de las 3 tablas de obligación (Fase TP), por
 *                        `negotiated_date ?? original_due_date` — el mismo pendiente que consume el
 *                        Calendario de Pagos, sin doble-conteo (se usa la obligación, no la allocation).
 *
 * ⚠️ «Sin datos» ≠ cero (ADR-056): si bancos no tiene movimientos, el **saldo inicial se DECLARA
 * no disponible** (`available:false`, `null`) y el `saldo_proyectado` absoluto queda en `null` — se
 * sigue mostrando el NETO por semana (cobros − pagos), que sí es real. Una semana sin obligaciones es
 * 0 real (no "sin datos"): la ausencia de fuente y el cero de negocio son distintos.
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export interface CashflowOpts { from?: string; to?: string }

@Injectable()
export class BudgetCashflowService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async projection(opts: CashflowOpts = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const from = opts.from ?? new Date().toISOString().slice(0, 10);
    const to = opts.to ?? this.addDays(from, 56); // 8 semanas por default
    if (!DATE_RX.test(from) || !DATE_RX.test(to)) throw new BadRequestException('Fechas inválidas (YYYY-MM-DD)');
    if (to < from) throw new BadRequestException('`to` no puede ser anterior a `from`');

    return this.tk.run(async (trx) => {
      // ── Saldo inicial (bancos) — DECLARADO, no asumido ────────────────────────
      const [bank] = await trx('finance.bank_movements')
        .where({ tenant_id: tenantId }).whereNull('deleted_at')
        .select(trx.raw('count(*)::int AS n'), trx.raw('max(movement_date) AS as_of'));
      let opening: { available: boolean; amount: number | null; as_of: string | null; source: string; reason?: string };
      if (Number(bank.n) > 0) {
        // última running_balance por cuenta activa, sumada
        const [agg] = await trx
          .with('ult', (qb) => qb
            .distinctOn('bank_account_id')
            .from('finance.bank_movements')
            .where({ tenant_id: tenantId }).whereNull('deleted_at')
            .select('bank_account_id', 'running_balance')
            .orderBy([{ column: 'bank_account_id' }, { column: 'movement_date', order: 'desc' }, { column: 'created_at', order: 'desc' }]))
          .from('ult').select(trx.raw('coalesce(sum(running_balance),0) AS saldo'));
        opening = { available: true, amount: round2(Number(agg.saldo)), as_of: bank.as_of, source: 'finance.bank_movements' };
      } else {
        opening = { available: false, amount: null, as_of: null, source: 'finance.bank_movements', reason: 'Sin movimientos bancarios cargados (Fase CB) para este tenant' };
      }

      // ── Cobros previstos (cartera CXC) por semana ─────────────────────────────
      const cobros = await trx('analytics.customer_receivables')
        .where({ tenant_id: tenantId })
        .andWhere('saldo_documento', '>', 0)
        .whereBetween('vencimiento', [from, to])
        .groupByRaw("date_trunc('week', vencimiento)")
        .select(trx.raw("date_trunc('week', vencimiento)::date AS bucket"), trx.raw('coalesce(sum(saldo_documento),0) AS monto'));
      const [cobrosMeta] = await trx('analytics.customer_receivables').where({ tenant_id: tenantId })
        .select(trx.raw('max(computed_at) AS as_of'));

      // ── Pagos previstos (3 obligaciones) por semana ───────────────────────────
      const pagoSql = (table: string) => trx(table)
        .where({ tenant_id: tenantId }).whereNotIn('status', ['cancelled', 'propuesta'])
        .whereRaw('original_amount > paid_amount')
        .whereRaw('coalesce(negotiated_date, original_due_date) BETWEEN ? AND ?', [from, to])
        .select(
          trx.raw("date_trunc('week', coalesce(negotiated_date, original_due_date))::date AS bucket"),
          trx.raw('(original_amount - paid_amount) AS pending'),
        );
      const pagosUnion = pagoSql('budget.expense_obligations')
        .unionAll([pagoSql('commercial.supplier_payment_obligations'), pagoSql('finance.financial_commitments')]);
      const pagos = await trx.from(pagosUnion.as('u')).groupBy('bucket')
        .select('bucket', trx.raw('coalesce(sum(pending),0) AS monto'));

      // ── Ensamble semanal (semanas vacías = 0 real, no "sin datos") ────────────
      const cobMap = new Map(cobros.map((r: any) => [this.iso(r.bucket), Number(r.monto)]));
      const pagMap = new Map(pagos.map((r: any) => [this.iso(r.bucket), Number(r.monto)]));
      const weeks = this.weekBuckets(from, to);
      let acumNeto = 0;
      let saldo = opening.available ? (opening.amount as number) : null;
      let saldoMin: number | null = saldo;
      const buckets = weeks.map((wk) => {
        const c = round2(cobMap.get(wk) ?? 0);
        const p = round2(pagMap.get(wk) ?? 0);
        const neto = round2(c - p);
        acumNeto = round2(acumNeto + neto);
        const saldoProy = opening.available ? round2((opening.amount as number) + acumNeto) : null;
        if (saldoProy != null) { saldo = saldoProy; if (saldoMin == null || saldoProy < saldoMin) saldoMin = saldoProy; }
        return { week: wk, cobros: c, pagos: p, neto, neto_acumulado: acumNeto, saldo_proyectado: saldoProy };
      });

      // ── Alerta de insuficiencia — solo si hay saldo inicial (si no, se DECLARA) ─
      const alerts = opening.available
        ? buckets.filter((b) => (b.saldo_proyectado as number) < 0)
            .map((b) => ({ week: b.week, saldo_proyectado: b.saldo_proyectado, tipo: 'falta_liquidez' as const }))
        : [];

      return {
        period: { from, to, bucket: 'week' },
        opening_balance: opening,
        totals: {
          cobros: round2(buckets.reduce((s, b) => s + b.cobros, 0)),
          pagos: round2(buckets.reduce((s, b) => s + b.pagos, 0)),
          neto: round2(acumNeto),
        },
        saldo_minimo_proyectado: opening.available ? saldoMin : null,
        buckets,
        alerts,
        sources: {
          cobros: { source: 'analytics.customer_receivables', as_of: cobrosMeta?.as_of ?? null },
          pagos: { source: 'budget.expense_obligations + commercial.supplier_payment_obligations + finance.financial_commitments' },
          saldo_inicial: opening,
        },
        notes: {
          saldo_proyectado: opening.available
            ? 'saldo_proyectado = saldo_inicial + Σ(cobros − pagos) acumulado.'
            : 'Sin saldo inicial de bancos (Fase CB): el saldo_proyectado y la alerta de insuficiencia van en null. El NETO por semana sí es real.',
          no_doble_conteo: 'Pagos = pendiente (original − pagado) de la obligación, NO las allocations del Calendario (evita doble-conteo).',
        },
      };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────
  private iso(d: any): string { return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10); }
  private addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  /** Lunes (date_trunc('week') de Postgres = lunes) de cada semana en el rango. */
  private weekBuckets(from: string, to: string): string[] {
    const monday = (d: string) => { const x = new Date(d + 'T00:00:00Z'); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; };
    const out: string[] = [];
    let cur = monday(from); const end = monday(to);
    while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 7); }
    return out;
  }
}
