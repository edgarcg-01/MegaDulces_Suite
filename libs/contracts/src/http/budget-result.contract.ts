import type { Freshness } from './provenance.contract';

/**
 * `[PU.R]` **Estado de resultados del presupuesto** — plan contra real, renglón por renglón.
 *
 * ── POR QUÉ ESTE CONTRATO EXISTE ─────────────────────────────────────────────────────────────
 * `GET finance/budget/budgets/:id/resultado` ya existía y publicaba `ingresos − egresos`. Medido
 * contra prod el 2026-10-03 sobre el ejercicio FY2027 real, eso daba:
 *
 *     Resultado  $468,804,497.42      Margen  100.00 %
 *
 * ⛔ No por un error de cálculo: la fórmula **no tiene costo de ventas**, que en una distribuidora
 * es el 88 % del egreso, y el plan de gastos está vacío, así que `egresos` valía 0 y los meses sin
 * plan se dibujaban en `$0.00` en vez de declararse. Un presupuesto no puede decir «100 % de
 * margen»: el renglón que falta es justo el grande.
 *
 * ── LA FORMA, Y POR QUÉ CADA CELDA ES `number | null` ────────────────────────────────────────
 * Cada renglón trae **plan** y **real** por separado, y los dos pueden ser `null` (ADR-056). Un
 * `0` significa «el negocio movió cero»; un `null` significa «no hay con qué medirlo», y en esta
 * pantalla la diferencia es el mensaje entero: hoy el real está completo y el plan casi vacío, y
 * eso es lo que hay que poder leer de un vistazo.
 */

/** Una celda del estado de resultados: lo planeado y lo que de verdad pasó. */
export interface BudgetResultCell {
  /** `null` = no hay presupuesto para este renglón en este mes. NUNCA 0 por ausencia. */
  plan: number | null;
  /** `null` = la fuente del real no tiene datos del mes. NUNCA 0 por ausencia. */
  real: number | null;
}

/** Un mes del estado de resultados. El orden de las claves es el orden de lectura del P&L. */
export interface BudgetResultMonth {
  year_month: string;
  venta: BudgetResultCell;
  /** ⛔ El renglón que la versión anterior no tenía. Es el 88 % del egreso de la operación. */
  costo_ventas: BudgetResultCell;
  margen_bruto: BudgetResultCell;
  gasto_operativo: BudgetResultCell;
  /** Gastos financieros e impuestos (familia 7 de Kepler). */
  financieros: BudgetResultCell;
  resultado: BudgetResultCell;
  margen_bruto_pct: BudgetResultCell;
  /** real / plan de la venta. `null` si falta cualquiera de los dos. */
  cumplimiento_venta_pct: number | null;
  /**
   * ⚠️ Dinero que SALE y que **no es resultado**: va al flujo, no al P&L. Se publica al lado a
   * propósito — sumarlo al gasto es el error que convierte $55.9 M de gasto operativo en $516.6 M.
   */
  fuera_del_resultado: {
    /** Compra de mercancía a proveedores (cuenta 511). Es flujo, no costo de ventas. */
    compra_inventario: number | null;
    /** Activo no circulante (cuenta 150). */
    inversion: number | null;
  };
}

/** De dónde sale cada pierna, y si hoy tiene con qué. */
export interface BudgetResultSource {
  key: string;
  label: string;
  /** El objeto de base de datos, textual. Para que nadie tenga que adivinarlo. */
  source: string;
  available: boolean;
  /** Por qué no está disponible. Obligatorio cuando `available` es `false`. */
  reason: string | null;
}

/**
 * `[ADR-059]` El árbitro de un renglón: otra implementación del mismo hecho, con su veredicto.
 * `no_comparable` no es una falla: es que las dos cifras miden universos distintos y decirlo es
 * más honesto que restarlas.
 */
export interface BudgetResultArbitro {
  renglon: string;
  mio: number | null;
  arbitro: number | null;
  fuente_arbitro: string;
  delta: number | null;
  delta_pct: number | null;
  veredicto: 'cuadra' | 'difiere' | 'no_comparable' | 'no_medido';
  nota: string;
}

/** Lo que esta pantalla NO puede medir, con nombre y monto. Nunca se dibuja como cero. */
export interface BudgetResultHueco {
  key: string;
  label: string;
  /** `null` cuando ni siquiera el tamaño del hueco se pudo medir. */
  monto: number | null;
  nota: string;
}

export interface BudgetResultAnnual {
  venta: BudgetResultCell;
  costo_ventas: BudgetResultCell;
  margen_bruto: BudgetResultCell;
  gasto_operativo: BudgetResultCell;
  financieros: BudgetResultCell;
  resultado: BudgetResultCell;
  margen_bruto_pct: BudgetResultCell;
  compra_inventario: number | null;
  inversion: number | null;
}

export interface BudgetResult {
  budget: { id: string; name: string; fiscal_year: number; status: string };
  from: string;
  to: string;
  months: BudgetResultMonth[];
  annual: BudgetResultAnnual;
  sources: BudgetResultSource[];
  arbitros: BudgetResultArbitro[];
  huecos: BudgetResultHueco[];
  freshness: Freshness;
}
