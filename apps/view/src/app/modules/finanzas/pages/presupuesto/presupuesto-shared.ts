/**
 * `[PVI.9]` — Tipos del **presupuesto de ventas**, compartidos entre el shell y la vista Ventas.
 *
 * Vivían dentro de `finanzas-presupuesto.component.ts` (líneas 113–177), un archivo de **2,719
 * líneas que tocan al menos cinco carriles** — Ventas, Tesorería, Gastos, VP y Sucursales. Medido
 * el 2026-10-09 sobre ese archivo: de los 28 identificadores del bloque Ventas, **26 no los usa
 * ninguna otra vista**. O sea que el bloque no estaba enredado con el resto: estaba **co-ubicado**.
 *
 * Se mueven verbatim, con sus comentarios: cada uno documenta una medición que ya costó algo.
 *
 * ⚠️ Ninguno de estos tipos se usaba fuera de ese archivo (verificado con un grep sobre
 *    `apps/view/src`), así que sacarlos no le cambia la forma a nadie más.
 */
import type { Freshness, Coverage } from '@megadulces/contracts';

export { money } from '../finanzas-format';

/**
 * Lo mínimo que la vista Ventas necesita del ejercicio elegido.
 *
 * ⭐ Es un tipo PROPIO y no `BudgetHeader` del shell, a propósito: importarlo del shell crearía un
 *    ciclo (shell → vista → shell) y ataría esta vista a la forma completa del encabezado, de la
 *    que sólo usa cuatro campos. TypeScript es estructural: el `BudgetHeader` del shell satisface
 *    esto sin convertir nada.
 */
export interface BudgetRef { id: string; name: string; fiscal_year: number; status: string }

// ── Presupuesto de ventas (PV) ──
export interface SalesCell {
  entity_key: string; channel: string; channel_label: string; entity_type: string;
  warehouse_code: string; branch_name: string | null; period_no: number;
  meta: number | null; real: number | null; real_prior: number | null;
  cumplimiento_pct: number | null; crec_pct: number | null; part_pct: number | null;
  method: string | null;
}
export interface SalesComparison {
  budget: { id: string; name: string; fiscal_year: number; status: string };
  prior_year: number;
  cells: SalesCell[];
  totals: { meta: number; real: number | null; real_prior: number; cumplimiento_pct: number | null; crec_pct: number | null };
  /** [PU.V6] Cuánto AÑO cubre `totals.meta`. Va fuera de `totals` a propósito: adentro, alguien lo sumaría. */
  periodos?: {
    del_anio: number; con_meta: number; sin_meta: number[]; completo: boolean;
    /** Lo que esos períodos valieron en el último ejercicio COMPLETO. `null` = no se pudo medir, nunca $0. */
    referencia: { fiscal_year: number; monto: number } | null;
    nota: string;
  };
  data_as_of: string | null;
  real_available: boolean;
  freshness: Freshness; coverage: Coverage;
}
export interface SalesEntity { entity_key: string; channel: string; channel_label: string; entity_type: string; warehouse_code: string; branch_name: string | null; route_code: string | null; route_zona: string | null }
export interface SalesRow {
  label: string; channel_label: string; entity_key: string | null; is_rollup: boolean;
  meta: number | null; real: number | null; cumplimiento_pct: number | null; crec_pct: number | null; part_pct: number | null;
  method: string | null;
}
// PVA — propuesta automática
export interface GrowthChannel { growth_pct: number; basis: string; paired_periods: number; years_used: number[] }
export interface GrowthProposal {
  by_channel: Record<string, GrowthChannel>;
  global: { growth_pct: number; basis: string; paired_periods: number };
  years_available: number[]; fiscal_year: number; min_paired_periods?: number;
}
export interface GrowthEditRow { channel: string; channel_label: string; growth_pct: number; basis: string; paired_periods: number }
export interface ProposeCoverage {
  historico_ajustado: number; estacional: number; proxy_canal: number; sin_base_declarado: number; no_signal: number; manual_kept: number;
  /**
   * `[PVI.2]` El DINERO por método. `coverage` cuenta CELDAS, y el dinero no se reparte por celda:
   * medido en prod, el proxy eran 104 de 429 celdas (24.2 %) **y** $197,160,564 (24.46 % de la
   * meta) — que casi coincidieran fue casualidad de ese ejercicio, no una regla, y **nadie
   * calculaba el segundo**. Opcional a propósito: contra una API que todavía no lo emite la
   * pantalla **declara que no lo midió**, en vez de quedarse en blanco o dibujar un 0.
   */
  coverage_monto?: { historico_ajustado: number; estacional: number; proxy_canal: number; sin_base_declarado: number };
  meta_total?: number;
  /** Fracción de la meta repartida con el PROMEDIO DE OTRAS entidades del canal. `null` si la meta
   *  es 0: una meta de 0 no tiene «0 % sin base», tiene un porcentaje indefinido. */
  proxy_canal_pct?: number | null;
}
export interface IndicatorSeries { year: number; real: number | null; crec_pct: number | null; part_pct: number | null }
export interface IndicatorCurrent { meta: number | null; real: number | null; cumplimiento_pct: number | null; crec_pct: number | null }
export interface IndicatorRow { channel?: string; channel_label: string; label?: string; entity_key?: string; series: IndicatorSeries[]; current: IndicatorCurrent }
export interface SalesIndicators {
  budget: { id: string; name: string; fiscal_year: number; status: string };
  prior_year: number; years_available: number[];
  company: { series: IndicatorSeries[]; current: IndicatorCurrent };
  by_channel: IndicatorRow[]; by_entity: IndicatorRow[];
  data_as_of: string | null; real_available: boolean;
  freshness: Freshness;
}
export interface ReconAnnualRow { channel: string; channel_label: string; year: string; sell_out: number; facturacion: number; delta: number; ratio_pct: number | null; status: string }
export interface SalesReconciliation { annual: ReconAnnualRow[]; monthly: unknown[]; notes: string[]; data_as_of: string | null; freshness: Freshness }

/** Las tres pestañas de la vista Ventas. */
export type SalesTab = 'plan' | 'indicadores' | 'conciliacion';
