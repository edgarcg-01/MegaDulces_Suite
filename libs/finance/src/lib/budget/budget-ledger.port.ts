/**
 * Fase PU (Bloque B1/B2 — unificar en el ledger, ADR-066) — Puerto para que el Calendario de Pagos
 * (Fase TP) MUEVA el ledger de 5 estados de la partida (`budget.budget_lines`) cuando un gasto
 * autorizado se compromete / se paga / se cancela.
 *
 * ── POR QUÉ UN PUERTO Y NO UNA INYECCIÓN DIRECTA ─────────────────────────────────────────────
 * `FinanceBudgetModule` (PU) y `FinancePaymentCalendarModule` (TP) están separados a propósito. El
 * puerto los une por un TOKEN, no por la clase concreta: TP depende de esta interfaz; el binding
 * `useExisting: BudgetLinesService` es el único punto que los ata. Así cerramos la deriva de las
 * «dos verdades del gasto» (el ledger reflejaba lo del presupuesto; TP pagaba por su cuenta) sin
 * acoplar los dominios más de lo necesario.
 *
 * ── POR QUÉ `trx` EN LA FIRMA (no abrir tk.run adentro) ──────────────────────────────────────
 * La regla del proyecto prohíbe anidar `TenantKnexService.run()`. El Calendario ya corre dentro de
 * SU transacción; el movimiento del ledger tiene que ocurrir en ESA MISMA trx para ser atómico
 * (comprometer/pagar y actualizar la obligación, todo o nada). Por eso el puerto recibe el `trx` del
 * llamador y NO abre uno nuevo.
 *
 * ── `Knex.Transaction`, no `unknown` (`[NX.11]`, 2026-09-21) ─────────────────────────────────
 * Este puerto nació con `trx: unknown`, y eso obligaba a la implementación a declarar `trx: any`
 * para poder usarlo — que es justo lo que `scripts/lint-boundary-gate.js` rechaza en líneas
 * nuevas. `unknown` tampoco protegía nada: el único valor que se pasa acá es la transacción de
 * `TenantKnexService.run()`, que ES un `Knex.Transaction`, y nombrarla no acopla nada nuevo
 * (`knex` ya es dependencia de `libs/finance`). Con el tipo real, el puerto y su implementación
 * quedan sanos de punta a punta y desaparecen los `any`.
 */

import { Knex } from 'knex';

export const BUDGET_LEDGER_PORT = 'BUDGET_LEDGER_PORT';

export type BudgetLedgerMovement = 'compromiso' | 'ejercido' | 'pago' | 'cancelacion';

export interface BudgetLedgerApplyOpts {
  sourceKind?: string;
  sourceRef?: string;
  note?: string;
  /** compromiso: convertir desde una reserva previa en vez de consumir disponible nuevo. */
  fromReserva?: boolean;
}

export interface BudgetLedgerPort {
  /**
   * Aplica un movimiento del ledger sobre la partida `budgetLineId`, DENTRO de la trx del llamador
   * (nunca abre tk.run). Idempotente por `(sourceKind, sourceRef, tipo)`. Puede lanzar
   * `BadRequestException` (sobregiro con control_level='bloqueo', compromiso insuficiente, etc.) —
   * el llamador decide si eso debe bloquear su operación o registrarse como deriva.
   */
  applyInTrx(
    trx: Knex.Transaction,
    budgetLineId: string,
    type: BudgetLedgerMovement,
    amount: number,
    opts: BudgetLedgerApplyOpts,
    username: string,
    cancelTarget?: 'reserva' | 'compromiso',
  ): Promise<void>;
}
