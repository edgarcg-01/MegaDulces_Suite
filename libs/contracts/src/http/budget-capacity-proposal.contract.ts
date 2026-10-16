import type { IncomeChannel } from './budget-income-forecast.contract';

/**
 * `[PU.14]` **La propuesta de capacidad de pago por día** — `GET finance/budget/capacity/propose`.
 *
 * Dos bases, y la respuesta dice cuál se usó:
 *  · `ingreso_estimado` (default desde PU.14): lo que entra cada día hábil (real si ya está cargado,
 *    si no el estimado de ingresos vigente) + lo que entró en los días inhábiles anteriores.
 *  · cartera (`cobranza_esperada…`): la cobranza esperada de la semana repartida entre sus días hábiles.
 *    Es el respaldo: si no hay estimado que cubra el rango, la propuesta cae aquí y `respaldo_de` dice
 *    por qué.
 *
 * Read-only: nada se escribe hasta `POST …/capacity/confirm`.
 */

export type CapacityOrigen = 'real' | 'estimado' | 'mixto';

export interface CapacityProposalItem {
  date: string;
  amount: number;
  /** Lunes de la semana del día. */
  week: string;
  /** Base cartera: la cobranza esperada de la semana. `null` en la base de ingreso. */
  cobros_week: number | null;
  /** Base ingreso: lo que entra ese día (real o estimado). */
  ingreso_dia?: number;
  /** Base ingreso: lo que entró en los días inhábiles anteriores y se suma a éste. */
  arrastre?: number;
  arrastre_de?: string[];
  origen?: CapacityOrigen;
  /** Estado del lote si ese día ya pasó a Pagos (released/executing/closed): la confirmación lo salta. */
  bloqueado?: string | null;
}

export interface CapacityCobranzaCobertura {
  en_ventana: number;
  vencido_fuera: number;
  posterior: number;
  sin_vencimiento: number;
  total: number;
  pct_en_ventana: number | null;
}

export interface CapacityProposal {
  available: boolean;
  from: string;
  to: string;
  /** `ingreso_estimado`, o la base de cartera (`cobranza_esperada…`). */
  basis: string;
  /** Por qué no hay propuesta (cuando `available` es false). */
  reason?: string;
  note?: string;
  /** Base ingreso: nombre de la versión del estimado usada. */
  version?: string;
  /** Base ingreso: último día cargado por canal (lo real llega hasta ahí). */
  real_hasta?: Record<IncomeChannel, string | null>;
  /** Base ingreso: días hábiles del rango sin real ni estimado (no se proponen en cero). */
  sin_estimado?: string[];
  /** Si se cayó a cartera: por qué no se pudo con el estimado de ingresos. */
  respaldo_de?: string;
  /** Base cartera. */
  as_of?: string | null;
  base?: string;
  cobranza_cobertura?: CapacityCobranzaCobertura;
  items: CapacityProposalItem[];
}

/** Respuesta de `POST …/capacity/confirm`: lo que se escribió y lo que se saltó por estar ya en Pagos. */
export interface CapacityConfirmResult {
  written: number;
  omitidos: Array<{ date: string; status: string; motivo: string }>;
}
