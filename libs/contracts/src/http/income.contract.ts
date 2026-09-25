/**
 * `[IG.1]` La FORMA del wire de Ingresos contables (`/finanzas/ingresos`).
 *
 * Vive acá y no en cada lado por la razón de siempre (ADR-052 / ADR-056): el tipo de `Freshness`
 * nació en un dominio y **a los tres días ya estaba copiado a mano** en el frontend. Acá la forma se
 * declara una vez y un cambio es error de compilación en los dos lados, que es la garantía por la
 * que existe este paquete.
 *
 * La LÓGICA (las tres reglas duras, el clasificador de canal) no está acá: vive en
 * `analytics.income_entries_src()` — ver la migración `20260925150000`.
 */

import type { Coverage, Freshness } from './provenance.contract';

/** Dimensión de agrupación del reporte. */
export type IncomeGroupBy = 'canal' | 'plaza' | 'mes' | 'documento';

export interface IncomeCanalRow {
  canal: string;
  label: string;
  total: number;
  movs: number;
}

export interface IncomeRow {
  key: string;
  label: string;
  canal: string | null;
  total: number;
  movs: number;
  share_pct: number;
  prev_total: number | null;
  delta_pct: number | null;
}

export interface IncomeSeriesPoint {
  mes: string;
  total: number;
  mostrador: number;
  telemarketing: number;
  ruta: number;
  vecinal: number;
  contado: number;
  otro: number;
  /** El rango corta ese mes → su barra es más baja por calendario, no por venta. */
  parcial: boolean;
  /** Plazas que reportaron ese mes. Un escalón acá explica un escalón en el total. */
  plazas: number;
}

/**
 * Cobertura del período. Extiende la `Coverage` del contrato de procedencia con el detalle que la
 * pantalla necesita para poder NOMBRAR lo que quedó afuera — `measured`/`pct`/`note` solos dicen
 * que falta algo, no qué.
 *
 * `grupos` es la plaza del lado ingreso y la sucursal del lado gasto: el motor
 * (`period-coverage.ts`) es el mismo y recibe la etiqueta del que llama.
 */
export interface PeriodCoverageWire extends Coverage {
  grupos: string[];
  grupos_todos: string[];
  grupos_parciales: Array<{ grupo: string; desde: string; total: number }>;
  meses_parciales: string[];
}

/** El Δ con y sin los grupos que cambiaron de universo entre los dos períodos. */
export interface PeriodComparativoWire {
  grupos_ambos: string[];
  solo_actual: string[];
  solo_previo: string[];
  total: number;
  total_prev: number;
  delta_pct: number | null;
  total_comparable: number;
  total_prev_comparable: number;
  delta_pct_comparable: number | null;
  universo_cambio: boolean;
}

export interface IncomeReport {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  freshness: Freshness;
  coverage: PeriodCoverageWire;
  comparativo: PeriodComparativoWire | null;
  group_by: string;
  total: number;
  movimientos: number;
  by_canal: IncomeCanalRow[];
  rows: IncomeRow[];
  series: IncomeSeriesPoint[];
}

export interface IncomeTreeNode {
  key: string;
  label: string;
  level: string;
  total: number;
  movs: number;
  share_pct: number;
  children?: IncomeTreeNode[];
}

export interface IncomeTree {
  from: string;
  to: string;
  total: number;
  tree: IncomeTreeNode[];
}

/**
 * `[IG.3]` Una de las cuatro fuentes del mismo peso de venta.
 *
 * `monto: null` significa **NO MEDIDO**, y es distinto de `0`. `comparable: false` marca la fuente
 * que NO se resta de frente: la cobranza es lo que se cobró, no lo que se devengó, y su diferencia
 * es plazo de crédito, no faltante.
 */
export interface IncomeSourceRow {
  key: string;
  label: string;
  monto: number | null;
  delta_pct: number | null;
  comparable: boolean;
  /** ISO del último cierre del feed que produjo este número, cuando se pudo medir. */
  medido_al?: string | null;
  nota: string;
}

export interface IncomeSources {
  from: string;
  to: string;
  fuentes: IncomeSourceRow[];
}
