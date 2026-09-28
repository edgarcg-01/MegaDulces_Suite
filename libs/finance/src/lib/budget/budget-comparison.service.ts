import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, evalInput, composeFreshness, laneAt, FRESHNESS_UNKNOWN } from '@megadulces/platform-core';
import type { Coverage, Freshness } from '@megadulces/contracts';

/**
 * Fase PU.2 — Presupuestos: presupuesto vs real (ADR-066 / ADR-056 / ADR-059).
 *
 * Dos "reales", con orígenes distintos y honestos:
 *   1. Ejecución presupuestaria (EXACTA, interna): lo que el propio ledger reconoció
 *      (reservado/comprometido/ejercido/pagado por partida). Sin ODS.
 *   2. Real del ODS (DERIVADO, cero importers): ventas/costo/margen de `analytics.mv_sales_blended`
 *      (el fact arbitrado, ADR-059), a nivel TENANT × PERIODO. NO se auto-cruza por partida sobre
 *      dimensiones adivinadas — eso sería inventar atribución (spec §6/§9). El cruce por partida
 *      (regla de correspondencia cuenta↔dimensión) queda declarado, no construido.
 *
 * ⛔ [AUD-DAT.1] LA FUENTE ERA `analytics.sales_daily` Y CUBRE 6 DE 8 SUCURSALES.
 * No es un bug del fact: su propio importer lo declara en la primera línea —*"Fuente:
 * mart.ventas_enriched (consolidación on-prem, **6 sucursales**)"*. Morelia Madero (07) y Morelia
 * Abastos (08) vivieron en Wincaja hasta su corte a Kepler (2026-09-08 y 2026-09-19, ver
 * `analytics.v_branch_erp_cutover`), y `sales_daily` las tiene **desde ese día, no antes**. Lo que
 * faltaba era que ese alcance VIAJARA con el número (ADR-056): esta pantalla lo llamaba "el Real
 * del ODS" y comparaba el presupuesto contra una venta sin Morelia.
 *
 * Medido en prod 2026-09-28, contra el mismo periodo:
 *     2026 ene-sep   sales_daily $313,391,770  →  mv_sales_blended $464,309,751   (+48.2%)
 *     2026-08        sales_daily  $34,811,550  →  mv_sales_blended  $54,265,356   (+55.9%)
 *     margen         11.76%                    →  11.83%   (la TASA estaba bien; la BASE no)
 * El hueco histórico completo son **$409.8M** de venta Wincaja de Morelia que el ODS sí tiene.
 * Corroborado por un linaje independiente: `mv_wincaja_sales_daily` coincide dentro del 0.5%.
 *
 * `mv_sales_blended` es el destino que `[SD.3]` ya eligió el 2026-09-14 —con medición (cuadran al
 * 0.19%) y candado (`test-newdb-sales-lineage-parity`)— para rentabilidad, sell-out y weekly. Esta
 * pantalla nació tres días DESPUÉS leyendo la fuente vieja: el primitivo existía y no se generalizó,
 * que es exactamente el patrón que ADR-056 nombra. Acá sólo se la engancha al linaje que ya ganó.
 *
 * Reglas duras:
 *   - «Sin datos» ≠ cero (ADR-056): si el ODS no tiene filas del periodo, `available=false` y los
 *     importes reales van en `null`, nunca en 0.
 *   - Frescura DECLARADA, y medida donde corresponde. ⚠️ `mv_sales_blended.updated_at` **NO es la
 *     marca del refresco**: es la fecha de venta truncada a medianoche (medido: 763 valores
 *     distintos, el más viejo `2000-01-01`, el más nuevo `2026-09-28 00:00:00` mientras la matvista
 *     había refrescado a las 06:33). Usar `max(updated_at)` diría "al día" siempre, que es el mismo
 *     defecto que VP.0 midió en 21 de 24 píldoras. El `data_as_of` sale del **latido de entrega**
 *     del refresco (`laneAt('analytics_refresh_blended')`, ADR-053), con el umbral que ya está
 *     registrado en `CRON_JOBS` (warnH 26) — no uno inventado acá.
 *   - Tenant EXPLÍCITO en el filtro (los objetos de `analytics.*` no siempre traen RLS forzado).
 */

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? round2((num / den) * 100) : null);

/**
 * [SD.3] Mismo nombre y mismo valor que en `commercial-profitability`, `commercial-analytics` y
 * `weekly-analytics`. Constante, no literal, para que el próximo movimiento de linaje sea un cambio
 * por archivo y no una cacería de strings.
 */
const SALES_FACT = 'analytics.mv_sales_blended';
/** Carril que refresca `SALES_FACT`. Su umbral vive en `CRON_JOBS` (db-health), warnH 26. */
const SALES_FACT_LANE = 'analytics_refresh_blended';
const SALES_FACT_LANE_WARN_H = 26;

export interface SummaryOpts { from?: string; to?: string; warehouseId?: string; includeReal?: boolean }

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

      // ── 2. Real del ODS (analytics.mv_sales_blended) — tenant × periodo ──────
      // Se difiere por defecto (opt-in con includeReal): agregar el fact sobre un año es una consulta
      // pesada que no debe bloquear la carga del ejercicio (gate <1s). «diferido» ≠ «sin datos» ≠ cero.
      let real: any;
      // [PU-VP] Procedencia declarada por el SERVER (ADR-056): frescura ternaria + cobertura medida.
      let realFreshness: Freshness = FRESHNESS_UNKNOWN;
      let realCoverage: Coverage = { measured: false, pct: null, note: 'Real vs presupuesto no cargado (se pide aparte con includeReal).' };
      if (!opts.includeReal) {
        real = { available: false, deferred: true, source: SALES_FACT, data_as_of: null,
                 reason: 'Real vs presupuesto no cargado (se consulta el sell-out del ODS aparte)', ventas: null, costo: null, margen: null, unidades: null };
      } else {
        const q = trx(SALES_FACT).where({ tenant_id: tenantId }).whereBetween('sale_date', [from, to]);
        if (opts.warehouseId) q.andWhere({ warehouse_id: opts.warehouseId });
        const [agg] = await q.select(
          trx.raw('count(*)::int AS n'),
          trx.raw('count(*) FILTER (WHERE cost IS NOT NULL)::int AS cost_n'),
          trx.raw('coalesce(sum(revenue),0) AS ventas'),
          trx.raw('coalesce(sum(cost),0) AS costo'),
          // `mv_sales_blended` NO tiene columna `margin` (lo declara [SD.3]) → se deriva. Ojo: se
          // deriva sobre los MISMOS agregados, así que arrastra la misma salvedad de cobertura de
          // costo de abajo — no es un margen "mejor", es el mismo con otro nombre.
          trx.raw('coalesce(sum(revenue),0) - coalesce(sum(cost),0) AS margen'),
          trx.raw('coalesce(sum(units),0) AS unidades'),
        );
        // El sello de frescura NO sale de la fila (ver cabecera): sale del latido del refresco.
        const dataAsOf = await laneAt(trx, SALES_FACT_LANE);
        const available = Number(agg.n) > 0;
        // Cobertura de costo (ADR-051/059): sum(cost) OMITE filas sin costo → margen sobredeclarado.
        // Se DECLARA la cobertura y se marca la confiabilidad; no se dibuja como completo (ADR-056).
        const costCov = available ? round2((Number(agg.cost_n) / Number(agg.n)) * 100) : null;
        real = available
          ? { available: true, source: SALES_FACT, data_as_of: dataAsOf,
              ventas: round2(Number(agg.ventas)), costo: round2(Number(agg.costo)),
              margen: round2(Number(agg.margen)), unidades: round2(Number(agg.unidades)),
              cost_coverage_pct: costCov }
          // «Sin datos» ≠ cero (ADR-056): importes en null, no 0.
          : { available: false, source: SALES_FACT, data_as_of: null,
              reason: 'Sin ventas registradas en el periodo/alcance', ventas: null, costo: null, margen: null, unidades: null,
              cost_coverage_pct: null };
        if (available) {
          // `laneAt` devuelve null cuando el carril no reporta — y eso es «no sé», no «al día»:
          // `evalInput` con `at=null` da status 'unknown', que es justo lo que ADR-056 pide.
          realFreshness = composeFreshness([evalInput(SALES_FACT_LANE, 'Sell-out consolidado del ODS', dataAsOf, SALES_FACT_LANE_WARN_H)]);
          realCoverage = { measured: true, pct: costCov, note: 'cost_coverage_pct = % de filas del periodo con costo (mezcla de fuentes, ADR-051/059).' };
        } else {
          realFreshness = FRESHNESS_UNKNOWN;
          realCoverage = { measured: false, pct: null, note: 'Sin ventas registradas en el periodo/alcance.' };
        }
      }
      const available = real.available as boolean;
      const costCovPct = (real.cost_coverage_pct ?? null) as number | null;

      // ── 3. KPIs (spec §10) — null cuando no hay base o no hay real ───────────
      const kpis = {
        cumplimiento_ventas_pct: available ? pct(real.ventas as number, presupuesto.ingresos) : null,
        desviacion_ventas: available ? round2((real.ventas as number) - presupuesto.ingresos) : null,
        desviacion_costo: available ? round2((real.costo as number) - presupuesto.costo_ventas) : null,
        margen_real: available ? round2((real.ventas as number) - (real.costo as number)) : null,
        // El margen sólo es confiable si el costo cubre ~todo el periodo; si no, se declara la salvedad (ADR-051/059).
        margen_real_confiable: available ? (costCovPct != null && costCovPct >= 99) : null,
        margen_real_cost_coverage_pct: costCovPct,
        margen_presupuestado: presupuesto.margen,
        ocupacion_presupuestaria_pct: ocupacion,
      };

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: budget.fiscal_year, status: budget.status, currency: budget.currency },
        period: { from, to },
        ejecucion: { ...totals, disponible, ocupacion_pct: ocupacion, by_type: byType.map((r: any) => this.withOccupancy(r)) },
        presupuesto,
        real,
        freshness: realFreshness,
        coverage: realCoverage,
        kpis,
        // Nota de alcance honesta para el consumidor (spec §5.1: identificar cobertura/integraciones).
        notes: {
          real_scope: 'Real a nivel tenant × periodo. El cruce por partida (correspondencia cuenta↔dimensión) está declarado, no construido (PU.0.5/§16.3).',
          gasto_real: 'El "ejercido" es presupuestario (reconocido en el ledger). La conciliación contra Contabilidad/GX es Capa 2-ext (spec §14 #13).',
          costo: 'El costo del fact MEZCLA fuentes (Wincaja real / Kepler álgebra ciega al precio — ADR-051/059) y sum(cost) omite filas sin costo, así que margen_real puede estar SOBREdeclarado. cost_coverage_pct declara la cobertura; margen_real_confiable=false cuando no cubre ~todo el periodo.',
        },
      };
    });
  }

  /**
   * Fase PR.4 (ADR-074) — Resultado presupuestado = plan de ventas (ingresos) − plan de gastos (egresos),
   * por mes y anual. Derivado de los dos planes (cero captura). Ingresos repartidos periodo(13×4)→mes por
   * días (mismo reparto que PVT). «Sin plan» de un lado se DECLARA (available:false), su lado va 0.
   */
  async resultado(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await this.assertBudget(trx, budgetId);
      const fy = Number(budget.fiscal_year);

      // Egresos por mes (nativo: expense_plan_lines.year_month)
      const egRows = await trx('budget.expense_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId })
        .groupBy('year_month').select('year_month').sum({ monto: 'monto' }) as unknown as Array<{ year_month: string; monto: number | string }>;
      const egMap = new Map<string, number>(egRows.map((r) => [r.year_month, round2(Number(r.monto))]));

      // Ingresos por periodo → mes (reparto por días vía v_retail_calendar)
      const inRows = await trx('budget.sales_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId })
        .groupBy('period_no').select('period_no').sum({ meta: 'meta_amount' }) as unknown as Array<{ period_no: number | string; meta: number | string }>;
      const calRes = await trx.raw(
        `SELECT period_no, to_char(date,'YYYY-MM') AS ym, count(*)::int AS days
           FROM analytics.v_retail_calendar WHERE fiscal_year = ? GROUP BY period_no, to_char(date,'YYYY-MM')`, [fy]);
      const periodMonths = new Map<number, Array<{ ym: string; days: number }>>();
      const periodTotal = new Map<number, number>();
      for (const r of (calRes.rows || calRes) as Array<{ period_no: number|string; ym: string; days: number|string }>) {
        const p = Number(r.period_no); if (!periodMonths.has(p)) periodMonths.set(p, []);
        periodMonths.get(p)!.push({ ym: r.ym, days: Number(r.days) }); periodTotal.set(p, (periodTotal.get(p) || 0) + Number(r.days));
      }
      const inMap = new Map<string, number>();
      for (const r of inRows) {
        const p = Number(r.period_no); const meta = Number(r.meta); const months = periodMonths.get(p); const total = periodTotal.get(p) || 0;
        if (!months || !(total > 0)) continue;
        for (const m of months) inMap.set(m.ym, round2((inMap.get(m.ym) || 0) + meta * (m.days / total)));
      }

      const months: Array<{ year_month: string; ingresos: number; egresos: number; resultado: number }> = [];
      for (let mm = 1; mm <= 12; mm++) {
        const ym = `${fy}-${String(mm).padStart(2, '0')}`;
        const ing = round2(inMap.get(ym) || 0); const eg = round2(egMap.get(ym) || 0);
        months.push({ year_month: ym, ingresos: ing, egresos: eg, resultado: round2(ing - eg) });
      }
      const totIng = round2(months.reduce((s, m) => s + m.ingresos, 0));
      const totEg = round2(months.reduce((s, m) => s + m.egresos, 0));

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: fy, status: budget.status },
        months,
        annual: { ingresos: totIng, egresos: totEg, resultado: round2(totIng - totEg), margen_pct: totIng > 0 ? round2(((totIng - totEg) / totIng) * 100) : null },
        sources: {
          ingresos: { source: 'budget.sales_plan_lines', available: inRows.length > 0, reason: inRows.length ? null : 'Sin plan de ventas propuesto' },
          egresos: { source: 'budget.expense_plan_lines', available: egRows.length > 0, reason: egRows.length ? null : 'Sin plan de gastos propuesto' },
        },
        note: 'Resultado presupuestado = plan de ventas (ingresos) − plan de gastos (egresos). Derivado de los planes; ingresos repartidos periodo→mes por días.',
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
