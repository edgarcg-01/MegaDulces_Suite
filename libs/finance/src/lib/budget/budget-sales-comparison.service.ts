import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PV.4 — Presupuesto de Ventas: comparación meta vs real + CREC + PART (ADR-066 / PV).
 *
 * Arma el pivote del molde del Excel: ENTIDAD (PV.2) × PERIODO 13×4 (PV.1), con
 *   · meta   = `budget.sales_plan_lines` (PV.3)
 *   · real   = `analytics.v_sellout_daily` rolado por el calendario 13×4 (universo ÚNICO del
 *              sell-out — el MISMO dato de explainChange/salesQuery, sólo bucketeado a periodo;
 *              NO se recalcula ni se inventa una segunda fuente)
 *   · CREC   = crecimiento YoY = (real_FY − real_FY-1) / real_FY-1   (por celda)
 *   · PART   = participación/mezcla = real de la celda / total real del ejercicio
 *   · cumplimiento = real / meta
 *
 * Reglas duras del proyecto: «sin datos» ≠ cero (sin real → NULL, no 0; sin meta → NULL);
 * frescura DECLARADA (`data_as_of` = último business_date del sell-out). Cero importer:
 * el real es una vista sobre el ODS.
 */

export interface SalesComparisonCell {
  entity_key: string;
  channel: string;
  channel_label: string;
  entity_type: string;
  warehouse_code: string;
  branch_name: string | null;
  period_no: number;
  meta: number | null;
  real: number | null;
  real_prior: number | null;
  cumplimiento_pct: number | null; // real / meta
  crec_pct: number | null;         // YoY
  part_pct: number | null;         // real / total real del ejercicio
  method: string | null;           // origen de la meta: historico_ajustado | estacional | manual | null
}

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num: number | null, den: number | null): number | null =>
  num == null || den == null || den === 0 ? null : round2((num / den) * 100);

@Injectable()
export class BudgetSalesComparisonService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async getComparison(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!budget) throw new NotFoundException('Presupuesto no encontrado');
      const fy = Number(budget.fiscal_year);
      const priorYear = fy - 1;

      // entidades (eje columnas)
      const entities = await trx('analytics.v_sales_entity')
        .where({ tenant_id: tenantId })
        .orderBy([{ column: 'channel', order: 'asc' }, { column: 'warehouse_code', order: 'asc' }]);

      // meta por (entity_key, period_no) + su origen (method)
      const planRows = await trx('budget.sales_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId });
      const metaMap = new Map<string, number>();
      const methodMap = new Map<string, string>();
      for (const p of planRows) {
        metaMap.set(`${p.entity_key}|${p.period_no}`, Number(p.meta_amount));
        methodMap.set(`${p.entity_key}|${p.period_no}`, p.method);
      }

      // real (FY y FY-1) por (entity_key, period_no) — del sell-out diario por el calendario 13×4
      const realRows = await trx('analytics.v_sellout_daily as sd')
        .join('analytics.v_retail_calendar as cal', 'cal.date', 'sd.business_date')
        .join('analytics.v_sales_entity as se', function () {
          this.on('se.tenant_id', '=', 'sd.tenant_id')
            .andOn('se.channel', '=', 'sd.channel')
            .andOn('se.warehouse_code', '=', 'sd.warehouse_code');
        })
        .where('sd.tenant_id', tenantId)
        .whereIn('cal.fiscal_year', [fy, priorYear])
        .groupBy('se.entity_key', 'cal.fiscal_year', 'cal.period_no')
        .select('se.entity_key', 'cal.fiscal_year', 'cal.period_no')
        .sum({ real_monto: 'sd.monto' }) as unknown as Array<{ entity_key: string; fiscal_year: number; period_no: number | string; real_monto: number | string | null }>;

      const realMap = new Map<string, number>();      // FY
      const realPriorMap = new Map<string, number>(); // FY-1
      let totalReal = 0;
      for (const r of realRows) {
        const key = `${r.entity_key}|${Number(r.period_no)}`;
        const v = Number(r.real_monto) || 0;
        if (Number(r.fiscal_year) === fy) { realMap.set(key, v); totalReal += v; }
        else realPriorMap.set(key, v);
      }

      // celdas: entidad × periodo (1..13). Sólo emite la celda si hay meta O real (sin datos ≠ cero).
      const cells: SalesComparisonCell[] = [];
      for (const e of entities) {
        for (let period = 1; period <= 13; period++) {
          const key = `${e.entity_key}|${period}`;
          const meta = metaMap.has(key) ? Number(metaMap.get(key)) : null;
          const real = realMap.has(key) ? Number(realMap.get(key)) : null;
          const realPrior = realPriorMap.has(key) ? Number(realPriorMap.get(key)) : null;
          if (meta == null && real == null && realPrior == null) continue;
          cells.push({
            entity_key: e.entity_key,
            channel: e.channel,
            channel_label: e.channel_label,
            entity_type: e.entity_type,
            warehouse_code: e.warehouse_code,
            branch_name: e.branch_name,
            period_no: period,
            meta,
            real,
            real_prior: realPrior,
            cumplimiento_pct: pct(real, meta),
            crec_pct: realPrior == null || realPrior === 0 ? null : round2(((Number(real ?? 0) - realPrior) / realPrior) * 100),
            part_pct: real == null ? null : pct(real, totalReal),
            method: methodMap.get(key) ?? null,
          });
        }
      }

      // totales del ejercicio
      const totalMeta = planRows.reduce((s, p) => s + Number(p.meta_amount), 0);
      const totalRealPrior = [...realPriorMap.values()].reduce((s, v) => s + v, 0);

      // frescura declarada
      const fresh = await trx('analytics.v_sellout_daily').where({ tenant_id: tenantId }).max({ mx: 'business_date' }).first();
      const dataAsOf = fresh?.mx ? new Date(fresh.mx).toISOString().slice(0, 10) : null;

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: fy, status: budget.status },
        prior_year: priorYear,
        cells,
        totals: {
          meta: round2(totalMeta),
          real: round2(totalReal),
          real_prior: round2(totalRealPrior),
          cumplimiento_pct: pct(totalReal, totalMeta),
          crec_pct: totalRealPrior === 0 ? null : round2(((totalReal - totalRealPrior) / totalRealPrior) * 100),
        },
        data_as_of: dataAsOf,
        real_available: totalReal > 0 || totalRealPrior > 0,
      };
    });
  }
}
