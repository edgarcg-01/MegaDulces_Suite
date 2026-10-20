/**
 * `[TP.16]` Calendario de Pagos — vista semanal y «Ordenar y pagar».
 *
 * Forma de lo que ya devolvían `days/:date/summary` y `days/:date/allocations` (TP.1), ahora con
 * nombre en contratos, más la semana completa y las cuentas de ORIGEN (`finance.bank_accounts`).
 */

/**
 * `[TP.18]` `kepler_payable` es la deuda viva de Kepler que NO pasó por Entregas de Compras
 * (servicios, fletes, toda factura sin capturar). No tiene tabla propia: se deriva de
 * `analytics.v_supplier_payables` y su `obligation_id` es un uuid determinístico (ADR-094).
 */
export type PaymentObligationSource = 'budget_expense' | 'financial_commitment' | 'supplier_payable' | 'kepler_payable';
export type PaymentMethod = 'transferencia' | 'cheque' | 'efectivo' | 'cargo_automatico';

export interface PaymentCalendarDaySummary {
  date: string;
  /** `false` = Presupuestos no fijó capacidad ese día (distinto de capacidad CERO). */
  capacity_defined: boolean;
  authorized_amount: number | null;
  assigned_amount: number;
  remaining_amount: number | null;
  executed_amount: number;
  pending_execution_amount: number;
  exceeded: boolean;
  /** `draft | scheduled | in_prep | released | executing | closed`, o null sin pagos. */
  lot_status: string | null;
}

export interface PaymentCalendarAllocationItem {
  id: string;
  obligation_source: PaymentObligationSource;
  obligation_id: string;
  applied_amount: number;
  beneficiary: string;
  concept: string;
  supplier_id: string | null;
  /** `[TP.16.3]` Sucursal (centro de costo) de la factura; null fuera de facturas de proveedor. */
  branch_code: string | null;
}

export interface PaymentCalendarAllocation {
  id: string;
  classification: string;
  priority_rank: number | null;
  amount_assigned: number;
  status: string;
  payment_method: PaymentMethod | null;
  /** Cuenta de ORIGEN (la nuestra, de donde sale el dinero). */
  bank_account_id: string | null;
  /** `[TP.16]` Alias legible de la cuenta de origen (p. ej. «BBVA 6721»); null si no se eligió. */
  bank_account_label: string | null;
  /** Cuenta DESTINO: snapshot del catálogo del proveedor, o texto capturado. */
  destination_account_text: string | null;
  cash_register_text: string | null;
  reference_text: string | null;
  notes: string | null;
  failure_reason: string | null;
  folio: string | null;
  supplier_payment_account_id: string | null;
  items: PaymentCalendarAllocationItem[];
}

/**
 * `[TP.21.1]` **Lo que el libro de Tesorería dice de ESE día.**
 *
 * El Calendario y el *Programa de pagos* no son dos temas: son **la misma línea de tiempo** —el
 * día en que sale el dinero— cortada en dos, con el pasado en un Excel y el futuro en el sistema.
 * Medido el 2026-10-20: el libro llega hasta el **2026-08-28** y el calendario empieza el
 * **2026-10-16**; **0 días en común** y **53 días** en medio de los que ninguna de las dos
 * pantallas dice nada.
 *
 * ⛔ Esto **no casa renglones**: el libro no guarda el folio del pago de Kepler, y casar por
 * monto+mes es lo que produjo los $273 M indefendibles de `[PP.4]`. Acá sólo se **suma por
 * fecha**, que es la única llave que las dos comparten de verdad.
 */
export interface PaymentCalendarDayBook {
  /** Lo que el libro registra ese día. `0` con `mes_cargado: true` sí significa «no se pagó». */
  monto: number;
  n: number;
  /**
   * ⚠️ Si el mes de ese día **no está cargado** en el libro, `monto` es `0` por ausencia, no por
   * ausencia de pagos. Sin esta bandera las dos cosas se pintan igual — que es exactamente el
   * defecto que `[PP.10]` encontró escondiendo $91,720,679 en la conciliación mensual.
   */
  mes_cargado: boolean;
}

export interface PaymentCalendarWeekDay {
  date: string;
  summary: PaymentCalendarDaySummary;
  allocations: PaymentCalendarAllocation[];
  lot_folio: string | null;
  /** `[TP.21.1]` El pasado de este mismo día, según el libro. `null` = no se pudo medir. */
  libro?: PaymentCalendarDayBook | null;
}

export interface PaymentCalendarWeek {
  /** Lunes de la semana (YYYY-MM-DD). */
  from: string;
  /** Domingo de la semana (YYYY-MM-DD). */
  to: string;
  days: PaymentCalendarWeekDay[];
}

/** `[TP.16]` Cuenta de origen elegible para un pago (activa, banco o factoraje; nunca la caja). */
export interface PaymentOriginAccount {
  id: string;
  bank: string;
  account_label: string;
  alias: string | null;
  kind: string;
}
