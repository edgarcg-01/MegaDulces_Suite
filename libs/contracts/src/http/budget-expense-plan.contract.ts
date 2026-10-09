/**
 * `[PU.VG]` **Plan de gasto: procedencia y ritmo.** Las dos preguntas que el presupuesto de
 * egresos no sabía contestar, con la forma que viaja por HTTP.
 *
 * ── POR QUÉ VIVE ACÁ Y NO EN CADA LADO ───────────────────────────────────────────────────────
 * Estas dos formas nacieron en `libs/finance` y la pantalla las copió **a mano**. Es el patrón que
 * ADR-056 nombra y que este mismo carril ya midió: hay **10 tipos de cobertura declarados a mano**
 * en el repo, uno llamado `Coverage` a secas, y uno de ellos —`ExpenseCoverage`— es de esta misma
 * pantalla. Un contrato que se copia deja de ser un contrato al primer cambio de un lado solo.
 *
 * ── LAS DOS PREGUNTAS ────────────────────────────────────────────────────────────────────────
 *
 * **1. ¿De dónde salió este número?** (`ExpensePlanCoverage`) El motor arma el plan con tres
 * orígenes que hoy se suman igual: `observado` (el monto ES el gasto contable del mes),
 * `promedio_plano` (lo rellenó con suma/n y lo rotuló «estacional», que dice lo CONTRARIO de lo
 * que hace) y `ausente` (no hay renglón: suma $0.00 sin marcar nada). Medido en prod el
 * 2026-10-08: FY2027 publica **$18,871,884.76 = 25.21 %** de relleno plano.
 *
 * **2. ¿Vamos al ritmo?** (`ExpenseRhythm`) El ledger **no tiene eje de tiempo**
 * (`budget_lines.period_month` en NULL en las 139 filas de prod), así que `available_amount` es un
 * número ANUAL y un sobre-ejercicio no se ve hasta el cierre. El perfil se deriva del plan, que sí
 * tiene mes, y se publica **al lado** — meterlo en el grano cambiaría `source_ref` y borraría el
 * historial de movimientos.
 *
 * ── LA REGLA QUE ATRAVIESA A LAS DOS ─────────────────────────────────────────────────────────
 * **Lo que no se pudo medir se DECLARA.** `medido: false` con su motivo, y `null` donde no hay
 * cifra — nunca `0`, que suma en silencio y se lee como una medición. Y ninguna de las dos emite
 * semáforo: no hay umbral de materialidad registrado en ningún lado (cero columnas
 * `umbral|threshold` en `budget.*`, cero filas de gasto en `analytics.kpi_thresholds`), así que
 * `umbral_registrado: false` es parte del contrato, no un detalle de implementación.
 */

/** Cuántas celdas y cuánto dinero caen en un estado de procedencia. */
export interface ExpenseCoverageBucket {
  celdas: number;
  /** `null` cuando no hay importe que sumar. Nunca 0 por ausencia. */
  importe: number | null;
}

/**
 * La ventana que el ejercicio cubre de verdad. `fiscal_year` es un entero, no un periodo: los
 * meses viven sólo en `expense_plan_lines.year_month`. FY2026 cubre **5 de 12** y sus partidas
 * dicen `period_month = NULL`, que en este esquema significa «anual» — leerlo así subestima ~58 %.
 */
export interface ExpensePlanWindow {
  desde: string | null;
  hasta: string | null;
  meses: number;
  /** Siempre 12: el gasto va en meses naturales, NO en los 13 periodos del calendario de ventas. */
  meses_esperados: number;
  cobertura_pct: number | null;
  completa: boolean;
  nota: string | null;
}

export interface ExpensePlanCoverage {
  /** `false` cuando la vista derivada no está aplicada todavía. El motivo viene al lado. */
  medido: boolean;
  motivo: string | null;
  por_estado: Record<string, ExpenseCoverageBucket>;
  ventana: ExpensePlanWindow | null;
  total_publicado: number | null;
  /** Qué tanto de lo publicado NO lo observó nadie. Sin total no hay porcentaje: `null`, no 0. */
  relleno_pct: number | null;
  celdas_ausentes: number | null;
}

/**
 * Las tres primeras NO son veredictos: son ausencias, y **las arregla gente distinta**.
 * `sin_plan` → quien planea · `sin_perfil` → nadie, el periodo no empezó ·
 * `desfase_plan_vs_linea` → quien movió la partida después de materializar.
 */
export type ExpenseRhythmState =
  | 'sin_plan'
  | 'sin_perfil'
  | 'desfase_plan_vs_linea'
  | 'sin_consumo'
  | 'sobre_perfil'
  | 'bajo_perfil'
  | 'en_ritmo';

export interface ExpenseRhythmRow {
  account_code: string;
  sucursal: string;
  concept: string | null;
  /** Suma de los meses del plan YA CERRADOS. El mes en curso NO cuenta. `null` si no se puede. */
  deberia: number | null;
  /** `reserved + committed + exercised`. El pagado no entra: ya pasó por ejercido. */
  consumido: number;
  brecha: number | null;
  brecha_pct: number | null;
  meses_plan: number;
  meses_cerrados: number;
  anual_plan: number | null;
  anual_linea: number;
  estado: ExpenseRhythmState;
  motivo: string | null;
}

export interface ExpenseRhythmSummary {
  partidas: number;
  sobre_perfil: number;
  sin_consumo: number;
  no_evaluables: number;
  /** `null` si ninguna partida fue evaluable. Un 0 ahí afirmaría que no hay brecha. */
  brecha_total: number | null;
  /** Siempre `false` hoy: nadie registró un umbral de materialidad. El cliente NO pinta semáforo. */
  umbral_registrado: false;
}

/**
 * `[PU.VG.4]` **Un renglón de la bitácora del ledger.**
 *
 * `line_movements` es el libro que debería permitir RECOMPUTAR los acumuladores de una partida.
 * Hasta la mig `20261008181201` no se podía, por dos transiciones que no se registraban: una
 * `cancelacion` no decía **qué bucket bajó** (viajaba sólo en `note`, texto libre reemplazable) y
 * un `compromiso` no decía si **movió una reserva** o salió del disponible — los dos caminos
 * escribían un movimiento idéntico. Por eso `cancel_target` y `from_reserva` son parte del
 * contrato y no un detalle: sin ellos la bitácora se puede leer pero no se puede cuadrar.
 *
 * ⚠️ `cancel_target` en `null` significa **«no aplica»** (el movimiento no es una cancelación),
 * nunca «no sé»: el CHECK de la tabla lo exige en las dos direcciones.
 */
export interface BudgetLineMovement {
  id: string;
  budget_line_id: string;
  movement_type: string;
  amount: number | string;
  /** `'reserva' | 'compromiso'` en una cancelación; `null` cuando no aplica. */
  cancel_target: string | null;
  /** `true` sólo si un compromiso MOVIÓ una reserva previa en vez de consumir disponible. */
  from_reserva: boolean;
  counterpart_line_id: string | null;
  source_kind: string | null;
  source_ref: string | null;
  reverses_movement_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ExpenseRhythm {
  /** `YYYY-MM`. El perfil corta en el mes ANTERIOR a éste. */
  mes_en_curso: string;
  fuente: string;
  nota_grano: string;
  resumen: ExpenseRhythmSummary;
  partidas: ExpenseRhythmRow[];
}
