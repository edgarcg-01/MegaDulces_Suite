/**
 * `[PGP.121]` Las tres lecturas de «el banco dispara el pago» (`pago-por-el-banco.ts`). Sin tablas nuevas: los
 * pagos del Calendario, el estado de cuenta (`finance.bank_movements`, sólo cuentas de banco) y las salidas que ya
 * son la prueba de otro pago.
 */

/** Pagos pendientes de los últimos 60 días (hasta hoy) sin prueba de banco. Parámetros: `[tenant, hoy, hoy]`. */
export const SQL_PENDIENTES_POR_EL_BANCO = `
SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.amount_assigned::float8 AS importe,
       a.payment_method AS metodo, a.bank_account_id::text AS cuenta_planeada
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status = 'pending' AND a.paid_bank_movement_id IS NULL
   AND l.lot_date BETWEEN ?::date - 60 AND ?::date`;

/**
 * Las salidas de las cuentas de banco desde 3 días antes del pago más viejo hasta hoy (una fecha futura es un
 * error de captura del estado de cuenta, no una salida). Parámetros: `[tenant, desde, hoy]`.
 */
export const SQL_SALIDAS_POR_EL_BANCO = `
SELECT bm.id::text AS id, bm.bank_account_id::text AS cuenta_id, to_char(bm.movement_date, 'YYYY-MM-DD') AS fecha,
       bm.amount_out::float8 AS importe
  FROM finance.bank_movements bm
  JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id AND ba.kind = 'bank'
 WHERE bm.tenant_id = ? AND bm.deleted_at IS NULL AND bm.amount_out > 0
   AND bm.movement_date BETWEEN ?::date - 3 AND ?::date`;

/**
 * Los pagos probados por el banco que nadie ligó a Kepler, en el ORDEN en que se intentan escribir: primero los que
 * nunca se intentaron y, dentro de cada grupo, los más nuevos. Parámetros: `[tenant, desde, tope]`.
 *
 * ⛔ Por fecha ascendente había HAMBRE: un rechazo que no cambia (Tesorería ya lo capturó, acreedor que no es de
 * compra) se suelta y vuelve a la fila, y los más viejos ocupaban los `tope` lugares de cada pasada. Medido en la
 * primera pasada encendida (2026-11-14): tomó los 50 más viejos (20-oct a 6-nov), los 50 rechazados, y los 29 más
 * nuevos —con los 3 escribibles del servidor 00— no se habrían intentado nunca.
 */
export const SQL_PROBADOS_SIN_LIGAR = `
SELECT a.id::text AS id
  FROM finance.payment_allocations a
 WHERE a.tenant_id = ? AND a.status = 'executed'
   AND a.paid_bank_movement_id IS NOT NULL AND a.kepler_payment_folio IS NULL AND a.kepler_payment_linked_by IS NULL
   AND a.paid_bank_date >= ?::date
 ORDER BY EXISTS (SELECT 1 FROM finance.payment_allocation_history h
                   WHERE h.tenant_id = a.tenant_id AND h.allocation_id = a.id
                     AND h.event IN ('kepler_no_escrito', 'kepler_incierto')),
          a.paid_bank_date DESC, a.id
 LIMIT ?`;

/** Las salidas que ya son la prueba de un pago vigente. Parámetros: `[tenant]`. */
export const SQL_SALIDAS_LIGADAS = `
SELECT paid_bank_movement_id::text AS id
  FROM finance.payment_allocations
 WHERE tenant_id = ? AND paid_bank_movement_id IS NOT NULL AND status <> 'cancelled'`;
