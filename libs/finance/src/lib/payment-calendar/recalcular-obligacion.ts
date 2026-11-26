import type { Knex } from 'knex';

/**
 * `[PGP.211]` **El recálculo de una obligación, como pieza propia.** Era el cuerpo de
 * `PaymentCalendarService.recalcObligation`; vive aquí, sin Nest, para que el cargo de cada mes de un contrato
 * (`charge-contracts/cargo-del-mes.sql.ts`) reserve y pague con la MISMA regla que el Calendario, no con una copia
 * (ADR-056). El servicio importa de aquí el tipo, las tablas y el SQL de lo cubierto.
 */

export type ObligationSource = 'budget_expense' | 'financial_commitment' | 'supplier_payable' | 'kepler_payable';

/**
 * `[PGP.91]` **Lo que un item CUBRE de su factura**, en SQL: el neto que sale del banco más el
 * descuento que dio el proveedor. Toda suma que diga cuánto de una obligación está reservado o
 * pagado lee ESTO, para que el sobrante descontado no se vuelva a ofrecer mientras la nota de
 * crédito de Kepler no llega. ⛔ Lo que dice cuánto DINERO sale (`amount_assigned`, el tope del
 * día, los PDF, el cruce con el `X-D-26`) sigue leyendo `applied_amount` solo.
 */
export const SQL_CUBIERTO = '(i.applied_amount + i.discount_amount)';

/**
 * `[TP.18]` `null` = el origen **no tiene tabla propia**: es derivado de una vista del ERP y su
 * saldo se calcula al vuelo. Todo lo que lee o escribe una obligación tiene que preguntar por esto
 * antes de tocar una tabla — por eso el tipo lo obliga (`string | null`) en vez de dejarlo afuera.
 */
export const TABLE_BY_SOURCE: Record<ObligationSource, string | null> = {
  budget_expense: 'budget.expense_obligations',
  financial_commitment: 'finance.financial_commitments',
  supplier_payable: 'commercial.supplier_payment_obligations',
  kepler_payable: null,
};

/** Recalcula reserved_amount/paid_amount/status de UNA obligación desde sus items activos. */
export async function recalcularObligacion(trx: Knex.Transaction, source: ObligationSource, id: string): Promise<void> {
  const table = TABLE_BY_SOURCE[source];
  // `[TP.18]` El origen derivado no tiene dónde guardar `reserved_amount`/`paid_amount`: su
  // saldo se recalcula al vuelo en cada lectura, desde estos mismos items. No hay nada que
  // desincronizar, que es justamente lo que `recalcObligation` viene a evitar en los otros tres.
  if (!table) return;
  // `[PGP.91]` Reservado y pagado son lo CUBIERTO (neto + descuento al pagar), no sólo el neto:
  // una factura pagada con 3 % de descuento queda saldada aquí, y el 3 % no vuelve a ofrecerse
  // mientras Kepler no emite la nota de crédito. Respeta el CHECK reservado + pagado ≤ original
  // de las tres tablas porque lo cubierto nunca pasa del disponible (`createAllocation`/`addItem`).
  const [agg] = await trx('finance.payment_allocation_items as i')
    .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
    .where({ 'i.obligation_source': source, 'i.obligation_id': id })
    .select(
      trx.raw(`coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
      trx.raw(`coalesce(sum(${SQL_CUBIERTO}) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
    );
  const row = await trx(table).select('original_amount', 'status').where({ id }).first();
  if (!row) return;
  const reserved = Number(agg?.reserved ?? 0);
  const paid = Number(agg?.paid ?? 0);
  const newStatus = row.status === 'cancelled' ? 'cancelled'
    : paid >= Number(row.original_amount) ? 'paid'
    : (paid > 0 || reserved > 0) ? 'partial' : 'pending';
  await trx(table).where({ id }).update({ reserved_amount: reserved, paid_amount: paid, status: newStatus, updated_at: trx.fn.now() });
}
