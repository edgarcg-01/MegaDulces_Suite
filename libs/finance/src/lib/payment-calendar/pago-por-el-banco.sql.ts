/**
 * `[PGP.121]` Las tres lecturas de «el banco dispara el pago» (`pago-por-el-banco.ts`). Sin tablas nuevas: los
 * pagos del Calendario, el estado de cuenta (`finance.bank_movements`, sólo cuentas de banco) y las salidas que ya
 * son la prueba de otro pago.
 */

/** Pagos pendientes de los últimos 60 días (hasta hoy) sin prueba de banco. Parámetros: `[tenant, hoy, hoy]`. */
export const SQL_PENDIENTES_POR_EL_BANCO = `
SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.amount_assigned::float8 AS importe,
       a.payment_method AS metodo, a.bank_account_id::text AS cuenta_planeada, a.reference_text AS referencia
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status = 'pending' AND a.paid_bank_movement_id IS NULL
   AND l.lot_date BETWEEN ?::date - 60 AND ?::date`;

/**
 * `[PGP.201]` **Una salida que el banco devolvió no es un pago.** El SPEI rechazado aparece como su salida y, el mismo día
 * o a los pocos días, su devolución por el mismo importe en la misma cuenta (`raw_type = 'DS'`, «SPEI DEVUELTO…»,
 * «DEV. DEPOSITO ELECTRONICO»). Medido el 2026-11-23: 23 salidas devueltas desde septiembre (control +$100: 0); dos de
 * ellas (CF001 y CD048) se habían leído como «pagos repetidos». Fragmento para el `WHERE` de una salida del libro con
 * alias `a`.
 */
export function sqlLibroNoDevuelta(a = 'bm'): string {
  // tenant + cuenta + rango de fecha: el índice `ix_fin_mov_acct_date`. Escrito como resta de fechas recorría la tabla
  // entera dos veces (107 ms cada una, medido en prod el 2026-11-23).
  return `NOT EXISTS (SELECT 1 FROM finance.bank_movements dv
                       WHERE dv.tenant_id = ${a}.tenant_id AND dv.bank_account_id = ${a}.bank_account_id
                         AND dv.movement_date BETWEEN ${a}.movement_date AND ${a}.movement_date + 3
                         AND dv.deleted_at IS NULL AND dv.amount_in = ${a}.amount_out
                         AND (dv.raw_type = 'DS' OR dv.concept ~* '${RX_DEVOLUCION}'))`;
}
/** Lo mismo para una salida de la descarga del banco (`finance.bank_statement_lines`) con alias `a`. */
export function sqlDescargaNoDevuelta(a = 's'): string {
  return `NOT EXISTS (SELECT 1 FROM finance.bank_statement_lines dv
                       WHERE dv.tenant_id = ${a}.tenant_id AND dv.bank_account_id = ${a}.bank_account_id
                         AND dv.movement_date BETWEEN ${a}.movement_date AND ${a}.movement_date + 3
                         AND dv.amount_in = ${a}.amount_out
                         AND dv.concept ~* '${RX_DEVOLUCION}')`;
}
/** Cómo nombra el banco la devolución de una transferencia (Santander, BBVA, Banorte). */
export const RX_DEVOLUCION = 'DEVUEL|DEVOL|DEV\\. DEPOSITO|RECHAZ';

/** `[PGP.202]` Cuántos días sin un pago de Kepler desde una cuenta sin descarga la vuelven «dormida». */
export const DIAS_CUENTA_DORMIDA = 90;

/**
 * `[PGP.202]` **Una cuenta DORMIDA no impide decir «no salió».** Un pago que nadie preparó (sin cuenta, casi todos) sólo
 * se da por «no salió» si la descarga cubre esos días en TODAS las cuentas de banco activas (`[PGP.149]`). Una cuenta
 * activa a la que nunca se le subió descarga dejaba así «sin medir» a todos los pagos para siempre: medido el
 * 2026-11-23, una sola cuenta así (sin descarga nunca, el libro parado desde agosto, CERO pagos de Kepler desde ella en
 * 2026; control, la cuenta de cheques: 226 pagos en noviembre) frenaba todas las liberaciones desde el 19-nov.
 * Dormida = sin descarga nunca Y sin un pago de Kepler (`kdxe` abono, `c22` = la cuenta) en `DIAS_CUENTA_DORMIDA` días.
 * ⛔ Sólo cuenta para los pagos SIN cuenta preparada: el que alguien preparó EN esa cuenta sigue sin poder medirse.
 * Fragmento para el SELECT agrupado por la cuenta `ba` (con el `max(f.date_to)` de sus archivos); ~20 ms en prod.
 */
export function sqlCuentaDormida(ba = 'ba', hasta = 'max(f.date_to)'): string {
  return `(${hasta} IS NULL AND NOT EXISTS (
            SELECT 1 FROM kepler_ods.kdxe k
             WHERE k.c3 = 'D' AND btrim(k.c1) = k.sucursal AND btrim(k.c22) = btrim(${ba}.account_label)
               AND k.c7 >= (now() AT TIME ZONE 'America/Mexico_City')::date - ${DIAS_CUENTA_DORMIDA}))`;
}

/**
 * Las salidas de las cuentas de banco desde 3 días antes del pago más viejo hasta hoy (una fecha futura es un
 * error de captura del estado de cuenta, no una salida). Sin las devueltas (`[PGP.201]`). El concepto viaja para
 * reconocer un pago partido en varias transferencias (`referenciaDeSalida`). Parámetros: `[tenant, desde, hoy]`.
 */
export const SQL_SALIDAS_POR_EL_BANCO = `
SELECT bm.id::text AS id, bm.bank_account_id::text AS cuenta_id, to_char(bm.movement_date, 'YYYY-MM-DD') AS fecha,
       bm.amount_out::float8 AS importe, bm.concept AS concepto
  FROM finance.bank_movements bm
  JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id AND ba.kind = 'bank'
 WHERE bm.tenant_id = ? AND bm.deleted_at IS NULL AND bm.amount_out > 0
   AND bm.movement_date BETWEEN ?::date - 3 AND ?::date
   AND ${sqlLibroNoDevuelta('bm')}`;

/**
 * Los pagos probados por el banco —o, desde `[PGP.130]`, por su comprobante— que nadie ligó a Kepler, en el ORDEN en
 * que se intentan escribir: primero los que nunca se intentaron y, dentro de cada grupo, los más nuevos (la fecha del
 * banco o, si sólo hay comprobante, el día en que quedó pagado). Parámetros: `[tenant, desde, tope]`.
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
   AND (a.paid_bank_movement_id IS NOT NULL OR a.paid_proof_id IS NOT NULL)
   AND a.kepler_payment_folio IS NULL AND a.kepler_payment_linked_by IS NULL
   AND coalesce(a.paid_bank_date, (a.executed_at AT TIME ZONE 'America/Mexico_City')::date) >= ?::date
 ORDER BY EXISTS (SELECT 1 FROM finance.payment_allocation_history h
                   WHERE h.tenant_id = a.tenant_id AND h.allocation_id = a.id
                     AND h.event IN ('kepler_no_escrito', 'kepler_incierto')),
          coalesce(a.paid_bank_date, (a.executed_at AT TIME ZONE 'America/Mexico_City')::date) DESC, a.id
 LIMIT ?`;

/**
 * Las salidas que ya son la prueba de un pago vigente. `[PGP.201]` También las demás salidas de un pago partido en
 * varias transferencias, que guarda su bitácora (`detail.banco.grupo`): sin esto otro pago por el importe de una de
 * ellas se la podría quedar. Parámetros: `[tenant]`.
 */
export const SQL_SALIDAS_LIGADAS = `
WITH t AS (SELECT ?::uuid AS tenant)
SELECT a.paid_bank_movement_id::text AS id
  FROM finance.payment_allocations a, t
 WHERE a.tenant_id = t.tenant AND a.paid_bank_movement_id IS NOT NULL AND a.status <> 'cancelled'
UNION
SELECT jsonb_array_elements_text(h.detail -> 'banco' -> 'grupo') AS id
  FROM finance.payment_allocation_history h
  JOIN finance.payment_allocations a ON a.id = h.allocation_id, t
 WHERE a.tenant_id = t.tenant AND a.status <> 'cancelled'
   AND h.event IN ('pagado_por_el_banco', 'confirmado_por_el_banco', 'pagado_por_contrato')
   AND jsonb_typeof(h.detail -> 'banco' -> 'grupo') = 'array'`;

/**
 * `[PGP.146]` **Lo que dice la DESCARGA del banco de un pago atrasado.** Las tres lecturas de
 * `segunLaDescarga` (`pago-por-el-banco.ts`). La descarga es el archivo del propio banco que Finanzas sube a
 * diario (`finance.bank_statement_lines`); el estado de cuenta que leen las demás consultas de este archivo
 * (`finance.bank_movements`) sólo la recibe cuando la cuenta «usa el banco», y el 2026-11-18 no la usaba
 * ninguna: el libro se quedó en el 10-nov y 23 de 71 pagos atrasados ($2,964,539) ya habían salido según la
 * descarga (placebo, los mismos pagos 20 días después: 0 de 79).
 * ⛔ **Sólo se lee**: no marca pagado, no escribe en Kepler, no compite con `pagarPorElBanco`.
 */

/**
 * Quiénes reclaman una salida: los pagos pendientes Y los ya pagados de los últimos 60 días (hasta hoy). Un pagado
 * que no guardó su salida (lo pagó Kepler, o el libro) sigue siendo dueño de ella: sin él, el pendiente de al lado
 * por el mismo importe se la quedaría. Parámetros: `[tenant, hoy, hoy]`.
 */
export const SQL_RECLAMANTES_DE_LA_DESCARGA = `
SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.amount_assigned::float8 AS importe,
       a.payment_method AS metodo, a.bank_account_id::text AS cuenta_planeada, a.status, a.reference_text AS referencia
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status IN ('pending', 'executed')
   AND l.lot_date BETWEEN ?::date - 60 AND ?::date`;

/** Las salidas de la descarga en esos 60 días más el margen de la ventana. Parámetros: `[tenant, hoy, hoy]`. */
export const SQL_SALIDAS_DE_LA_DESCARGA = `
SELECT s.id::text AS id, s.bank_account_id::text AS cuenta_id, to_char(s.movement_date, 'YYYY-MM-DD') AS fecha,
       s.amount_out::float8 AS importe, s.concept AS concepto
  FROM finance.bank_statement_lines s
  JOIN finance.bank_accounts ba ON ba.id = s.bank_account_id AND ba.kind = 'bank'
 WHERE s.tenant_id = ? AND s.amount_out > 0
   AND s.movement_date BETWEEN ?::date - 63 AND ?::date
   AND ${sqlDescargaNoDevuelta('s')}`;

/**
 * Hasta qué día cubre la descarga cada cuenta de banco activa: el fin del periodo del archivo más nuevo, no el
 * último movimiento (un día sin movimientos también está cubierto). Null = nunca se ha subido. `[PGP.202]` `dormida`:
 * no cuenta para los pagos sin cuenta preparada (`sqlCuentaDormida`). Parámetros: `[tenant]`.
 */
export const SQL_COBERTURA_DE_LA_DESCARGA = `
SELECT ba.id::text AS cuenta_id, coalesce(nullif(btrim(ba.alias), ''), ba.bank || ' ' || ba.account_label) AS cuenta,
       to_char(max(f.date_to), 'YYYY-MM-DD') AS hasta, ${sqlCuentaDormida('ba')} AS dormida
  FROM finance.bank_accounts ba
  LEFT JOIN finance.bank_statement_files f ON f.bank_account_id = ba.id AND f.tenant_id = ba.tenant_id
 WHERE ba.tenant_id = ? AND ba.kind = 'bank' AND ba.active
 GROUP BY ba.id, ba.alias, ba.bank, ba.account_label`;
