import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, evalInput, composeFreshness } from '@megadulces/platform-core';
import type { Coverage } from '@megadulces/contracts';

/**
 * Fase PVA.3 — Tablero de indicadores del Presupuesto de Ventas: CREC y PART por canal/entidad × año
 * (histórico) + meta-vs-real del ejercicio. Reproduce los bloques de consolidación del workbook
 * (PUNTO DE VENTA por plaza, MAYOREO, RD, con columnas CREC/PART) y reemplaza su rol de seguimiento.
 *
 * Todo deriva de `analytics.v_sellout_daily` por el calendario 13×4 (universo ÚNICO del sell-out) — no
 * se recalcula ni se inventa una segunda fuente. «Sin datos» ≠ cero; frescura declarada (`data_as_of`).
 *
 * CREC (histórico) = YoY anual = (real[año] − real[año-1]) / real[año-1] — dato observado, no una propuesta
 * (para display se muestra tal cual; el motor de PROPUESTA sí aplica su umbral de confiabilidad).
 * PART = participación = real / total compañía del mismo año.
 */

const CHANNEL_LABELS: Record<string, string> = {
  mostrador: 'Mostrador', credito: 'Mayoreo / Crédito', ruta: 'Ruta directa (RD)', preventa: 'Vecinal / Preventa',
};
const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num: number | null, den: number | null): number | null => (num == null || den == null || den === 0 ? null : round2((num / den) * 100));
// «Sin datos» ≠ cero (ADR-056): sin real actual (cur=null) el YoY es desconocido, NO −100%.
const yoy = (cur: number | null, prev: number | null): number | null => (cur == null || prev == null || prev === 0 ? null : round2(((cur - prev) / prev) * 100));

@Injectable()
export class BudgetSalesIndicatorsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async getIndicators(budgetId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const budget = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!budget) throw new NotFoundException('Presupuesto no encontrado');
      const fy = Number(budget.fiscal_year);
      const priorYear = fy - 1;

      // real anual por (entidad, canal, año) — del rollup del sell-out al grano 13×4.
      //
      // [PU.V1] Antes agregaba `v_sellout_daily × v_retail_calendar × v_sales_entity` EN VIVO sobre
      // TODOS los años (`fiscal_year <= fy`), con dos defectos que se arreglaron juntos:
      //
      //   ⛔ EL NÚMERO. `se.channel = sd.channel` une el canal CANÓNICO de la entidad contra el
      //      CRUDO del sell-out: se caían `credito`→`mayoreo` y `contado_nf`→`mostrador`, o sea
      //      **28.70 % del sell-out**. La MV pasa por `sellout_channel_map`, como `v_sales_entity`.
      //   ⛔ EL TIEMPO. Medido en prod: 61,182 ms contra un gate de 500 ms.
      //
      // ⚠️ Las MV no soportan RLS: el `tenant_id` va EXPLÍCITO (no lo pone `tk.run`).
      const rows = await trx('analytics.mv_sellout_budget_rollup')
        .where({ tenant_id: tenantId })
        .andWhere('fiscal_year', '<=', fy)
        .groupBy('entity_key', 'channel', 'branch_name', 'fiscal_year')
        .select('entity_key', 'channel', 'branch_name', 'fiscal_year')
        .sum({ real_monto: 'monto' }) as unknown as Array<{ entity_key: string; channel: string; branch_name: string | null; fiscal_year: number | string; real_monto: number | string | null }>;

      const years = [...new Set(rows.map((r) => Number(r.fiscal_year)))].sort((a, b) => a - b);
      // acumuladores
      const companyByYear = new Map<number, number>();
      const channelByYear = new Map<string, Map<number, number>>();
      const entityByYear = new Map<string, { channel: string; label: string; y: Map<number, number> }>();
      for (const r of rows) {
        const y = Number(r.fiscal_year); const v = Number(r.real_monto) || 0;
        companyByYear.set(y, (companyByYear.get(y) || 0) + v);
        if (!channelByYear.has(r.channel)) channelByYear.set(r.channel, new Map());
        channelByYear.get(r.channel)!.set(y, (channelByYear.get(r.channel)!.get(y) || 0) + v);
        if (!entityByYear.has(r.entity_key)) entityByYear.set(r.entity_key, { channel: r.channel, label: r.branch_name || r.entity_key, y: new Map() });
        const e = entityByYear.get(r.entity_key)!; e.y.set(y, (e.y.get(y) || 0) + v);
      }

      // meta del ejercicio por canal/entidad
      const planRows = await trx('budget.sales_plan_lines').where({ tenant_id: tenantId, budget_id: budgetId });
      const metaByChannel = new Map<string, number>();
      const metaByEntity = new Map<string, number>();
      let metaTotal = 0;
      for (const p of planRows) {
        const ch = String(p.entity_key).split(':')[0];
        metaByChannel.set(ch, (metaByChannel.get(ch) || 0) + Number(p.meta_amount));
        metaByEntity.set(p.entity_key, (metaByEntity.get(p.entity_key) || 0) + Number(p.meta_amount));
        metaTotal += Number(p.meta_amount);
      }

      const seriesFor = (byYear: Map<number, number>, companyRef: Map<number, number>) =>
        years.map((y, i) => {
          const real = byYear.get(y) ?? null;
          const prev = i > 0 ? byYear.get(years[i - 1]) ?? null : null;
          return { year: y, real: real == null ? null : round2(real), crec_pct: yoy(real, prev), part_pct: pct(real, companyRef.get(y) ?? null) };
        });

      const currentFor = (real: number | null, prior: number | null, meta: number | null) => ({
        meta: meta == null ? null : round2(meta), real: real == null ? null : round2(real),
        cumplimiento_pct: pct(real, meta), crec_pct: yoy(real, prior),
      });

      const company = {
        series: seriesFor(companyByYear, companyByYear),
        current: currentFor(companyByYear.get(fy) ?? null, companyByYear.get(priorYear) ?? null, metaTotal || null),
      };
      const by_channel = [...channelByYear.entries()]
        .sort((a, b) => (companyByYear.size ? (b[1].get(fy) ?? b[1].get(priorYear) ?? 0) - (a[1].get(fy) ?? a[1].get(priorYear) ?? 0) : 0))
        .map(([ch, byYear]) => ({
          channel: ch, channel_label: CHANNEL_LABELS[ch] || ch,
          series: seriesFor(byYear, companyByYear),
          current: currentFor(byYear.get(fy) ?? null, byYear.get(priorYear) ?? null, metaByChannel.get(ch) ?? null),
        }));
      const by_entity = [...entityByYear.entries()]
        .map(([ek, e]) => ({
          entity_key: ek, label: e.label, channel: e.channel, channel_label: CHANNEL_LABELS[e.channel] || e.channel,
          series: seriesFor(e.y, companyByYear),
          current: currentFor(e.y.get(fy) ?? null, e.y.get(priorYear) ?? null, metaByEntity.get(ek) ?? null),
        }))
        .sort((a, b) => a.channel.localeCompare(b.channel) || a.label.localeCompare(b.label));

      // [PU.V1] Frescura del MISMO rollup que las cifras. El sondeo anterior —`max(business_date)`
      // sobre `v_sellout_daily`— costaba **14,587 ms** medidos en prod: sin cambiarlo, arreglar la
      // consulta principal habría dejado la ruta en 14.6 s igual.
      const fresh = await trx('analytics.mv_sellout_budget_rollup')
        .where({ tenant_id: tenantId }).max({ mx: 'max_business_date' }).first();
      const dataAsOf = fresh?.mx ? new Date(fresh.mx).toISOString().slice(0, 10) : null;

      return {
        budget: { id: budget.id, name: budget.name, fiscal_year: fy, status: budget.status },
        prior_year: priorYear, years_available: years,
        company, by_channel, by_entity,
        data_as_of: dataAsOf,
        real_available: (companyByYear.get(fy) ?? 0) > 0 || (companyByYear.get(priorYear) ?? 0) > 0,
        // [PU-VP] Procedencia declarada por el SERVER (ADR-056).
        freshness: composeFreshness([evalInput('sellout_daily', 'Sell-out del ODS', fresh?.mx ?? null, 26)]),
        coverage: { measured: years.length > 0, pct: null,
          note: years.length ? `${years.length} año(s) de historia del sell-out (${years[0]}–${years[years.length - 1]}).` : 'Sin historia de sell-out.' } as Coverage,
      };
    });
  }

  /**
   * Conciliación DOCUMENTADA sell-out ↔ facturación contable (cta 401). Transparencia, sin ajuste:
   * el real del presupuesto sigue siendo el sell-out. Lidera con el grano ANUAL (donde reconcilia);
   * el mensual es lumpy por los asientos contables y se muestra como detalle declarado.
   */
  async getReconciliation() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.v_sellout_vs_facturacion')
        .where({ tenant_id: tenantId })
        .orderBy([{ column: 'year_month', order: 'asc' }, { column: 'channel', order: 'asc' }]);

      const CH = ['mostrador', 'credito', 'ruta', 'preventa'];
      const label: Record<string, string> = { mostrador: 'Mostrador', credito: 'Mayoreo / Crédito', ruta: 'Ruta directa (RD)', preventa: 'Vecinal / Preventa' };
      // agregado ANUAL por canal (Σ/Σ, no promedio de ratios)
      const byCY = new Map<string, { channel: string; channel_label: string; year: string; sell_out: number; facturacion: number; months: number }>();
      for (const r of rows) {
        const year = String(r.year_month).slice(0, 4);
        const k = `${r.channel}|${year}`;
        const e = byCY.get(k) || { channel: r.channel, channel_label: label[r.channel] || r.channel, year, sell_out: 0, facturacion: 0, months: 0 };
        e.sell_out += Number(r.sell_out); e.facturacion += Number(r.facturacion); e.months++;
        byCY.set(k, e);
      }
      const annual = [...byCY.values()].map((e) => {
        const ratio = e.sell_out > 0 ? e.facturacion / e.sell_out : null;
        return {
          channel: e.channel, channel_label: e.channel_label, year: e.year,
          sell_out: round2(e.sell_out), facturacion: round2(e.facturacion),
          delta: round2(e.facturacion - e.sell_out),
          ratio_pct: ratio == null ? null : round2(ratio * 100),
          status: e.sell_out <= 0 ? 'sin_sellout' : e.facturacion <= 0 ? 'sin_facturacion' : ratio! >= 0.8 && ratio! <= 1.7 ? 'concilia' : 'revisar',
        };
      }).sort((a, b) => a.year.localeCompare(b.year) || CH.indexOf(a.channel) - CH.indexOf(b.channel));

      const monthly = rows.map((r) => ({
        channel: r.channel, channel_label: label[r.channel] || r.channel, year_month: r.year_month,
        sell_out: Number(r.sell_out), facturacion: Number(r.facturacion), ratio_pct: r.ratio_pct == null ? null : Number(r.ratio_pct), status: r.status,
      }));

      // [PU.V1] Frescura barata y con FECHA REAL. El sondeo anterior era `max(business_date)` sobre
      // `v_sellout_daily` (**14,587 ms** medidos) — y esta ruta ya moría por timeout sin él.
      // ⚠️ NO se usa `max(year_month)` de `mv_sellout_monthly` aunque sea la fuente de las cifras:
      //    daría el string '2026-10', y `new Date('2026-10')` es el DÍA 1 del mes → la pantalla
      //    declararía hasta 30 días de rezago en un dato de ayer, y el umbral de 26 h saltaría en
      //    falso todos los meses. Se lee la fecha del rollup, que se refresca en el MISMO lote
      //    nocturno y sí es un `date`.
      const fresh = await trx('analytics.mv_sellout_budget_rollup')
        .where({ tenant_id: tenantId }).max({ mx: 'max_business_date' }).first();
      return {
        annual, monthly,
        notes: [
          'El real del presupuesto es el SELL-OUT; esta conciliación es sólo documentación — no ajusta ni reescala cifras.',
          // [PU.V1] Frescura DECLARADA (ADR-056): la pierna de sell-out pasó de la vista viva al
          // rollup mensual, que se refresca de noche. Para conciliar contra una balanza mensual es
          // lo correcto, pero el mes en curso va atrás y eso se dice, no se esconde.
          'La pierna de sell-out sale del rollup mensual (snapshot nocturno), no de la vista viva: el mes en curso puede ir un día atrás.',
          'Facturación = cuenta contable 401 producto (PISO/MAYOREO/VECINAL/RD), excluye fletes (401-002).',
          'Reconcilia a grano ANUAL: mostrador/credito/ruta caen en banda ~118-138% (el sell-out es el neto/parcial del bruto facturado). El grano mensual es lumpy por la irregularidad de los asientos contables.',
          'Preventa NO reconcilia: el vecinal en 401-003 aparece como un asiento de jul-ago 2026 (~$17M en 2 meses), no como flujo parejo — anomalía contable declarada.',
        ],
        data_as_of: fresh?.mx ? new Date(fresh.mx).toISOString().slice(0, 10) : null,
        // [PU-VP] Procedencia declarada por el SERVER (ADR-056).
        freshness: composeFreshness([evalInput('sellout_daily', 'Sell-out del ODS', fresh?.mx ?? null, 26)]),
      };
    });
  }
}
