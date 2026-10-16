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

export interface PaymentCalendarWeekDay {
  date: string;
  summary: PaymentCalendarDaySummary;
  allocations: PaymentCalendarAllocation[];
  lot_folio: string | null;
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
