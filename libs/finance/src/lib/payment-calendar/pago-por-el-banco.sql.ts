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

/** Las salidas que ya son la prueba de un pago vigente. Parámetros: `[tenant]`. */
export const SQL_SALIDAS_LIGADAS = `
SELECT paid_bank_movement_id::text AS id
  FROM finance.payment_allocations
 WHERE tenant_id = ? AND paid_bank_movement_id IS NOT NULL AND status <> 'cancelled'`;
