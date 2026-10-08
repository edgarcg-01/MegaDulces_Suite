import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, evalInput, composeFreshness } from '@megadulces/platform-core';
import type { Coverage } from '@megadulces/contracts';

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

      // real (FY y FY-1) por (entity_key, period_no) — del rollup del sell-out al grano 13×4.
      //
      // [PU.V1] Antes esto agregaba `v_sellout_daily × v_retail_calendar × v_sales_entity` EN VIVO,
      // y traía dos defectos que se arreglaron juntos en `mv_sellout_budget_rollup`:
      //
      //   ⛔ EL NÚMERO. Joineaba `se.channel = sd.channel`, pero `v_sales_entity` publica el canal
      //      CANÓNICO y el sell-out emite el CRUDO. Sólo casaban cuando coincidían, así que se
      //      caían enteros `credito`→`mayoreo` ($312,951,449) y `contado_nf`→`mostrador`
      //      ($1,477,412): **28.70 % del sell-out**, con `mayoreo:01/06/08` publicando **$0 sobre
      //      $208M** en FY2025. La MV pasa por `sellout_channel_map`, igual que `v_sales_entity`.
      //   ⛔ EL TIEMPO. Medido en prod: 56,397 ms máx / 45,796 ms prom contra un gate de 500 ms.
      //
      // ⚠️ Las MV no soportan RLS: el `tenant_id` va EXPLÍCITO (no lo pone `tk.run`).
      const realRows = await trx('analytics.mv_sellout_budget_rollup')
        .where({ tenant_id: tenantId })
        .whereIn('fiscal_year', [fy, priorYear])
        .groupBy('entity_key', 'fiscal_year', 'period_no')
        .select('entity_key', 'fiscal_year', 'period_no')
        .sum({ real_monto: 'monto' }) as unknown as Array<{ entity_key: string; fiscal_year: number; period_no: number | string; real_monto: number | string | null }>;

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
            // «Sin datos» ≠ cero (ADR-056): sin real actual, el CREC es desconocido, NO −100%.
            crec_pct: real == null || realPrior == null || realPrior === 0 ? null : round2(((real - realPrior) / realPrior) * 100),
            part_pct: real == null ? null : pct(real, totalReal),
            method: methodMap.get(key) ?? null,
          });
        }
      }

      // totales del ejercicio
      const totalMeta = planRows.reduce((s, p) => s + Number(p.meta_amount), 0);
      const totalRealPrior = [...realPriorMap.values()].reduce((s, v) => s + v, 0);

      // ════════════════════════════════════════════════════════════════════════════════════
      // [PU.V6] ⛔ CUÁNTO AÑO cubre este total. Medido en prod el 2026-10-08 sobre el
      // «Presupuesto 2027», y es la razón de que esto exista:
      //
      //   periodos 1–10 ... $604,775,116   (method `estacional`/`historico_ajustado`)
      //   periodos 11–13 ... **$0**        (method `sin_base_declarado`, 99 líneas)
      //
      // Los períodos 11, 12 y 13 son nov–ene, y en FY2025 fueron **$166,571,226: los tres
      // mejores del año** (una distribuidora de dulces). El motor hizo lo correcto —no inventó
      // una base que no existe, porque FY2026 va en el período 10— pero escribió el aviso en
      // `method` y un **$0 en `meta_amount`**, que es el campo que el encabezado suma.
      //
      // ⭐ Resultado: la pantalla publicaba «META TOTAL $604.8M» y una persona leía un año
      // completo. Son 10 de 13. Peor aún, invita a una conclusión al revés: parece +23.9 %
      // contra FY2026, y contra FY2025 **completo** ($608,567,893) es **−0.6 %** — plano.
      //
      // Acá NO se corrige el número (el motor tiene razón en no inventar): se DECLARA cuánto
      // año cubre, y con qué magnitud, para que el total no se lea como lo que no es (ADR-056).
      const PERIODOS_ANIO = 13;
      const metaPorPeriodo = new Map<number, number>();
      for (const p of planRows) {
        const n = Number(p.period_no);
        metaPorPeriodo.set(n, (metaPorPeriodo.get(n) ?? 0) + Number(p.meta_amount ?? 0));
      }
      const sinMeta: number[] = [];
      for (let p = 1; p <= PERIODOS_ANIO; p++) if (!(Number(metaPorPeriodo.get(p) ?? 0) > 0)) sinMeta.push(p);

      // La MAGNITUD de lo que falta: cuánto valieron esos períodos en el último año fiscal
      // COMPLETO. No se usa `prior_year` a secas porque justamente puede estar en curso —que es
      // la causa del hueco—; se busca el año más reciente con los 13 períodos.
      let referencia: { fiscal_year: number; monto: number } | null = null;
      if (sinMeta.length) {
        const completos = await trx('analytics.mv_sellout_budget_rollup')
          .where({ tenant_id: tenantId })
          .groupBy('fiscal_year')
          .havingRaw('count(distinct period_no) = ?', [PERIODOS_ANIO])
          .select('fiscal_year')
          .orderBy('fiscal_year', 'desc')
          .limit(1);
        const fyRef = completos.length ? Number(completos[0].fiscal_year) : null;
        if (fyRef != null) {
          const r = await trx('analytics.mv_sellout_budget_rollup')
            .where({ tenant_id: tenantId, fiscal_year: fyRef })
            .whereIn('period_no', sinMeta)
            .sum({ v: 'monto' })
            .first();
          referencia = { fiscal_year: fyRef, monto: round2(Number(r?.v ?? 0)) };
        }
      }
      const periodos = {
        del_anio: PERIODOS_ANIO,
        con_meta: PERIODOS_ANIO - sinMeta.length,
        sin_meta: sinMeta,
        completo: sinMeta.length === 0,
        // Magnitud declarada de lo que NO está presupuestado. `null` cuando no hay un año
        // completo con qué dimensionarlo: «no se pudo medir» ≠ $0 (ADR-056).
        referencia,
        nota: sinMeta.length === 0
          ? `El plan cubre los ${PERIODOS_ANIO} períodos del ejercicio.`
          : `El total cubre ${PERIODOS_ANIO - sinMeta.length} de ${PERIODOS_ANIO} períodos: `
            + `${sinMeta.join(', ')} no tienen meta porque ${priorYear} aún no llega a ellos`
            + (referencia ? `. En ${referencia.fiscal_year}, el último ejercicio completo, esos períodos valieron ${referencia.monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })}.` : '.'),
      };

      // Frescura declarada. [PU.V1] Sale del MISMO rollup que las cifras — antes era
      // `max(business_date)` sobre `v_sellout_daily`, que medido en prod costaba **14,587 ms**:
      // sin esto, arreglar la consulta principal habría dejado la ruta en 14.6 s de todos modos.
      // Y además declara la fecha de lo que se PUBLICA, no la de un dato que vive en otro lado.
      const fresh = await trx('analytics.mv_sellout_budget_rollup')
        .where({ tenant_id: tenantId }).max({ mx: 'max_business_date' }).first();
      const dataAsOf = fresh?.mx ? new Date(fresh.mx).toISOString().slice(0, 10) : null;
      const cellsWithReal = cells.filter((c) => c.real != null).length;

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: fy, status: budget.status },
        prior_year: priorYear,
        cells,
        // [PU.V6] Cuánto año cubre el total de arriba. Va FUERA de `totals` a propósito: si
        // viviera adentro, alguien lo sumaría.
        periodos,
        totals: {
          meta: round2(totalMeta),
          // «Sin datos» ≠ cero (ADR-056): sin real del ejercicio, el total va NULL, nunca $0.
          real: totalReal > 0 ? round2(totalReal) : null,
          real_prior: round2(totalRealPrior),
          cumplimiento_pct: totalReal > 0 ? pct(totalReal, totalMeta) : null,
          crec_pct: totalReal > 0 && totalRealPrior > 0 ? round2(((totalReal - totalRealPrior) / totalRealPrior) * 100) : null,
        },
        data_as_of: dataAsOf,
        real_available: totalReal > 0 || totalRealPrior > 0,
        // [PU-VP] Procedencia declarada por el SERVER (ADR-056): frescura ternaria + cobertura medida.
        freshness: composeFreshness([evalInput('sellout_daily', 'Sell-out del ODS', fresh?.mx ?? null, 26)]),
        coverage: { measured: cells.length > 0, pct: cells.length ? round2((cellsWithReal / cells.length) * 100) : null,
          note: cells.length ? `${cellsWithReal} de ${cells.length} celdas con real observado; el resto es meta sin real aún.` : 'Sin celdas con meta ni real.' } as Coverage,
      };
    });
  }
}
