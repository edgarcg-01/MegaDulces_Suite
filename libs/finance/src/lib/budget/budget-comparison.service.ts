import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PU.2 — Presupuestos: presupuesto vs real (ADR-066 / ADR-056 / ADR-059).
 *
 * Dos "reales", con orígenes distintos y honestos:
 *   1. Ejecución presupuestaria (EXACTA, interna): lo que el propio ledger reconoció
 *      (reservado/comprometido/ejercido/pagado por partida). Sin ODS.
 *   2. Real del ODS (DERIVADO, cero importers): ventas/costo/margen de `analytics.sales_daily`
 *      (el fact arbitrado, ADR-059), a nivel TENANT × PERIODO. NO se auto-cruza por partida sobre
 *      dimensiones adivinadas — eso sería inventar atribución (spec §6/§9). El cruce por partida
 *      (regla de correspondencia cuenta↔dimensión) queda declarado, no construido.
 *
 * Reglas duras:
 *   - «Sin datos» ≠ cero (ADR-056): si el ODS no tiene filas del periodo, `available=false` y los
 *     importes reales van en `null`, nunca en 0.
 *   - Frescura DECLARADA: `sales_daily` es una TABLA (ETL), no una vista viva → `data_as_of` =
 *     `max(updated_at)` de las filas leídas. No se asume "al momento".
 *   - Tenant EXPLÍCITO en el filtro (los objetos de `analytics.*` no siempre traen RLS forzado).
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? round2((num / den) * 100) : null);

export interface SummaryOpts { from?: string; to?: string; warehouseId?: string }

@Injectable()
export class BudgetComparisonService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Roll-up por tipo de partida: vigente + buckets + ocupación. Exacto, sin ODS. */
  async varianceByType(budgetId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await this.assertBudget(trx, budgetId);
      const rows = await trx('budget.budget_lines').where({ budget_id: budgetId })
        .groupBy('line_type')
        .select('line_type')
        .sum({ vigente: 'vigente_amount', reserved: 'reserved_amount', committed: 'committed_amount', exercised: 'exercised_amount', paid: 'paid_amount' });
      return rows.map((r: any) => this.withOccupancy(r));
    });
  }

  /** Resumen ejecutivo (spec §5.1): presupuesto vs real, disponible, ocupación, KPIs §10. */
  async executiveSummary(budgetId: string, opts: SummaryOpts = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await this.assertBudget(trx, budgetId);
      const [from, to] = this.period(budget, opts);

      // ── 1. Ejecución presupuestaria (interna, exacta) ────────────────────────
      const byType = await trx('budget.budget_lines').where({ budget_id: budgetId })
        .groupBy('line_type').select('line_type')
        .sum({ vigente: 'vigente_amount', reserved: 'reserved_amount', committed: 'committed_amount', exercised: 'exercised_amount', paid: 'paid_amount' });
      const t = (type: string, field: string) => round2(Number(byType.find((r: any) => r.line_type === type)?.[field] ?? 0));
      const totals = {
        vigente: round2(byType.reduce((s: number, r: any) => s + Number(r.vigente), 0)),
        reserved: round2(byType.reduce((s: number, r: any) => s + Number(r.reserved), 0)),
        committed: round2(byType.reduce((s: number, r: any) => s + Number(r.committed), 0)),
        exercised: round2(byType.reduce((s: number, r: any) => s + Number(r.exercised), 0)),
        paid: round2(byType.reduce((s: number, r: any) => s + Number(r.paid), 0)),
      };
      const disponible = round2(totals.vigente - totals.reserved - totals.committed - totals.exercised);
      const ocupacion = pct(totals.reserved + totals.committed + totals.exercised, totals.vigente);

      const presupuesto = {
        ingresos: t('ingreso', 'vigente'),
        costo_ventas: t('costo_ventas', 'vigente'),
        gasto: t('gasto', 'vigente'),
        margen: round2(t('ingreso', 'vigente') - t('costo_ventas', 'vigente')),
      };

      // ── 2. Real del ODS (analytics.sales_daily) — tenant × periodo ───────────
      const q = trx('analytics.sales_daily').where({ tenant_id: tenantId }).whereBetween('sale_date', [from, to]);
      if (opts.warehouseId) q.andWhere({ warehouse_id: opts.warehouseId });
      const [agg] = await q.select(
        trx.raw('count(*)::int AS n'),
        trx.raw('coalesce(sum(revenue),0) AS ventas'),
        trx.raw('coalesce(sum(cost),0) AS costo'),
        trx.raw('coalesce(sum(margin),0) AS margen'),
        trx.raw('coalesce(sum(units),0) AS unidades'),
        trx.raw('max(updated_at) AS data_as_of'),
      );
      const available = Number(agg.n) > 0;
      const real = available
        ? { available: true, source: 'analytics.sales_daily', data_as_of: agg.data_as_of,
            ventas: round2(Number(agg.ventas)), costo: round2(Number(agg.costo)),
            margen: round2(Number(agg.margen)), unidades: round2(Number(agg.unidades)) }
        // «Sin datos» ≠ cero (ADR-056): importes en null, no 0.
        : { available: false, source: 'analytics.sales_daily', data_as_of: null,
            reason: 'Sin ventas registradas en el periodo/alcance', ventas: null, costo: null, margen: null, unidades: null };

      // ── 3. KPIs (spec §10) — null cuando no hay base o no hay real ───────────
      const kpis = {
        cumplimiento_ventas_pct: available ? pct(real.ventas as number, presupuesto.ingresos) : null,
        desviacion_ventas: available ? round2((real.ventas as number) - presupuesto.ingresos) : null,
        desviacion_costo: available ? round2((real.costo as number) - presupuesto.costo_ventas) : null,
        margen_real: available ? round2((real.ventas as number) - (real.costo as number)) : null,
        margen_presupuestado: presupuesto.margen,
        ocupacion_presupuestaria_pct: ocupacion,
      };

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: budget.fiscal_year, status: budget.status, currency: budget.currency },
        period: { from, to },
        ejecucion: { ...totals, disponible, ocupacion_pct: ocupacion, by_type: byType.map((r: any) => this.withOccupancy(r)) },
        presupuesto,
        real,
        kpis,
        // Nota de alcance honesta para el consumidor (spec §5.1: identificar cobertura/integraciones).
        notes: {
          real_scope: 'Real a nivel tenant × periodo. El cruce por partida (correspondencia cuenta↔dimensión) está declarado, no construido (PU.0.5/§16.3).',
          gasto_real: 'El "ejercido" es presupuestario (reconocido en el ledger). La conciliación contra Contabilidad/GX es Capa 2-ext (spec §14 #13).',
        },
      };
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────
  private async assertBudget(trx: any, budgetId: string) {
    const b = await trx('budget.budgets').where({ id: budgetId }).first();
    if (!b) throw new NotFoundException('Presupuesto no encontrado');
    return b;
  }

  private period(budget: any, opts: SummaryOpts): [string, string] {
    if (opts.from && opts.to) return [opts.from, opts.to];
    const y = Number(budget.fiscal_year);
    return [`${y}-01-01`, `${y}-12-31`];
  }

  private withOccupancy(r: any) {
    const vigente = Number(r.vigente), reserved = Number(r.reserved), committed = Number(r.committed), exercised = Number(r.exercised), paid = Number(r.paid);
    return {
      line_type: r.line_type,
      vigente: round2(vigente), reserved: round2(reserved), committed: round2(committed),
      exercised: round2(exercised), paid: round2(paid),
      disponible: round2(vigente - reserved - committed - exercised),
      ocupacion_pct: pct(reserved + committed + exercised, vigente),
    };
  }
}
