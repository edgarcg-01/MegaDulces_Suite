'use strict';
/**
 * `[BFU.3.4]` — Quita los renglones de la descarga del banco que entraron DOS veces porque BBVA les completó la
 * referencia entre una descarga y otra («DEPOSITO EN EFECTIVO/» → «DEPOSITO EN EFECTIVO/0021089», mismo día, importe
 * y saldo). La llave del renglón llevaba el concepto y la segunda descarga los tomó como nuevos (el código que lo
 * evita va en el mismo commit: `renglones-repetidos.ts`).
 *
 * ── Lo medido antes (sólo lectura, pg-prod, 2026-11-20) ─────────────────────────────────────
 *  · 18 pares, todos depósitos, en dos cuentas BBVA (9 + 9), del 14 y 17-nov; cada repetido con UN solo original y
 *    cada original con UN solo repetido. Su suma es la diferencia exacta de «no cierra» de esas dos cuentas en Cuentas.
 *  · Nada humano colgado de los repetidos: 0 pagos del calendario, 0 programa de pagos, 0 capturas, 0 confirmaciones
 *    de ContPAQi, 0 clientes declarados. Sólo pareos del motor de conciliación (`motor-tes`): el motor casó unos con el
 *    original y otros con el repetido, y uno con los dos (a documentos distintos de Kepler).
 *
 * Lo que hace, por par (original = el del archivo más viejo, que se queda):
 *  1. los pareos del repetido pasan al original si el original no tiene ninguno; si ya tiene, se borran (el documento
 *     de Kepler queda libre para que el motor lo vuelva a casar);
 *  2. el original toma el concepto completo y la referencia (sólo si el texto nuevo EXTIENDE al viejo), la sucursal
 *     si no tenía, y queda `matched` si recibió pareos;
 *  3. el movimiento del repetido se marca borrado (`deleted_at`, `ignored`), como «Usar el banco» marca el libro;
 *  4. el renglón repetido de la descarga se borra (la tabla no tiene `deleted_at`) y su archivo descuenta `lines_new`;
 *  5. los totales del encabezado del periodo se re-derivan de los movimientos vivos (el saldo inicial y el final no
 *     cambian: los repetidos tienen el mismo saldo que su original).
 *
 * ⛔ No adivina: si un par no es 1:1 o aparecen más de 18, se detiene sin escribir nada.
 * Los renglones borrados se imprimen completos (id, cuenta, día, importe, concepto, llave) en la salida de la migración.
 *
 * ⚠️ Sólo UPDATE/DELETE, sin objetos de esquema: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA hasta que
 *    se aplique a mano. Aplicarla en cuanto esté en `origin/main`, antes de soltar.
 *
 * Idempotente: corrida otra vez no encuentra pares y no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const TOPE = 18;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = (await knex.raw(`SELECT to_regclass('finance.bank_statement_lines') IS NOT NULL AS ok`)).rows[0].ok;
  if (!hay) { console.log('[BFU.3.4] sin finance.bank_statement_lines: nada que hacer'); return; }

  await knex.raw(`DROP TABLE IF EXISTS pg_temp.bfu34_pares`);
  await knex.raw(`
    CREATE TEMP TABLE bfu34_pares AS
    WITH x AS (
      SELECT s.id, s.bank_account_id, s.file_id, s.line_key, s.concept, s.reference, s.raw_line, f.created_at AS fc,
             s.movement_date AS d, s.amount_in AS i, s.amount_out AS o, s.running_balance AS b
        FROM finance.bank_statement_lines s JOIN finance.bank_statement_files f ON f.id = s.file_id)
    SELECT p.id AS orig_line, q.id AS dup_line, p.line_key AS orig_key, q.line_key AS dup_key, q.file_id AS dup_file,
           p.bank_account_id AS cuenta, q.d, q.i, q.o, p.concept AS orig_concept, q.concept AS dup_concept,
           q.reference AS dup_reference, q.raw_line AS dup_raw,
           (SELECT m.id FROM finance.bank_movements m WHERE m.client_uuid = 'banco:' || p.line_key AND m.deleted_at IS NULL) AS mo,
           (SELECT m.id FROM finance.bank_movements m WHERE m.client_uuid = 'banco:' || q.line_key AND m.deleted_at IS NULL) AS md
      FROM x p JOIN x q
        ON p.bank_account_id = q.bank_account_id AND p.file_id <> q.file_id
       AND p.d = q.d AND p.i = q.i AND p.o = q.o AND p.b = q.b
       AND (q.fc > p.fc OR (q.fc = p.fc AND q.id > p.id))
     WHERE (p.i <> 0 OR p.o <> 0)`);

  const [{ n, origs, dups }] = (await knex.raw(
    `SELECT count(*)::int n, count(DISTINCT orig_line)::int origs, count(DISTINCT dup_line)::int dups FROM bfu34_pares`)).rows;
  if (n === 0) { await knex.raw(`DROP TABLE IF EXISTS pg_temp.bfu34_pares`); console.log('[BFU.3.4] ningún renglón repetido entre descargas: nada que hacer'); return; }
  if (n !== origs || n !== dups) throw new Error(`[BFU.3.4] los pares no son 1:1 (${n} pares, ${origs} originales, ${dups} repetidos): no se adivina`);
  if (n > TOPE) throw new Error(`[BFU.3.4] ${n} pares y se midieron ${TOPE}: algo cambió desde la medición, no se escribe nada`);

  const borrados = (await knex.raw(`
    SELECT p.dup_line, a.alias, to_char(p.d, 'YYYY-MM-DD') d, p.i, p.o, p.dup_concept, p.dup_key, p.orig_line, p.mo, p.md
      FROM bfu34_pares p JOIN finance.bank_accounts a ON a.id = p.cuenta ORDER BY a.alias, p.d, p.i`)).rows;

  const movidos = await knex.raw(`
    UPDATE finance.bank_recon_matches r SET bank_movement_id = p.mo
      FROM bfu34_pares p
     WHERE r.bank_movement_id = p.md AND p.mo IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM finance.bank_recon_matches z WHERE z.bank_movement_id = p.mo)`);
  const quitados = await knex.raw(`
    DELETE FROM finance.bank_recon_matches r USING bfu34_pares p WHERE r.bank_movement_id = p.md`);

  await knex.raw(`
    UPDATE finance.bank_movements m SET
           concept = CASE WHEN completa THEN p.dup_concept ELSE m.concept END,
           sucursal = coalesce(m.sucursal, d.sucursal),
           recon_status = CASE WHEN EXISTS (SELECT 1 FROM finance.bank_recon_matches z WHERE z.bank_movement_id = m.id) THEN 'matched' ELSE m.recon_status END,
           updated_at = now()
      FROM (SELECT *, length(norm_d) > length(norm_o) AND left(norm_d, length(norm_o)) = norm_o AS completa
              FROM (SELECT *, upper(regexp_replace(btrim(dup_concept), '\\s+', ' ', 'g')) norm_d,
                              upper(regexp_replace(btrim(orig_concept), '\\s+', ' ', 'g')) norm_o FROM bfu34_pares) t) p
      JOIN finance.bank_movements d ON d.id = p.md
     WHERE m.id = p.mo`);

  const soft = await knex.raw(`
    UPDATE finance.bank_movements m SET deleted_at = now(), recon_status = 'ignored', updated_at = now()
      FROM bfu34_pares p WHERE m.id = p.md AND m.deleted_at IS NULL`);

  await knex.raw(`
    UPDATE finance.bank_statement_lines s SET concept = p.dup_concept, reference = p.dup_reference, raw_line = p.dup_raw,
           updated_by = 'migracion BFU.3.4', updated_at = now()
      FROM (SELECT *, upper(regexp_replace(btrim(dup_concept), '\\s+', ' ', 'g')) norm_d,
                      upper(regexp_replace(btrim(orig_concept), '\\s+', ' ', 'g')) norm_o FROM bfu34_pares) p
     WHERE s.id = p.orig_line AND length(p.norm_d) > length(p.norm_o) AND left(p.norm_d, length(p.norm_o)) = p.norm_o`);

  await knex.raw(`
    UPDATE finance.bank_statement_files f SET lines_new = greatest(f.lines_new - c.n, 0), updated_at = now()
      FROM (SELECT dup_file, count(*)::int n FROM bfu34_pares GROUP BY dup_file) c WHERE f.id = c.dup_file`);
  const lineas = await knex.raw(`DELETE FROM finance.bank_statement_lines s USING bfu34_pares p WHERE s.id = p.dup_line`);

  // Los totales del encabezado (CB.75), de los movimientos vivos del periodo, como `refrescarEncabezadosDelBanco`.
  const antes = (await knex.raw(`
    SELECT st.id, a.alias, st.period, st.total_in, st.total_out, st.opening_balance, st.closing_balance
      FROM finance.bank_statements st JOIN finance.bank_accounts a ON a.id = st.bank_account_id
     WHERE st.id IN (SELECT m.statement_id FROM finance.bank_movements m JOIN bfu34_pares p ON p.md = m.id)`)).rows;
  await knex.raw(`
    UPDATE finance.bank_statements st SET
           total_in = coalesce(v.tin, 0), total_out = coalesce(v.tout, 0), updated_at = now()
      FROM (SELECT st2.id, sum(m.amount_in) tin, sum(m.amount_out) tout
              FROM finance.bank_statements st2
              LEFT JOIN finance.bank_movements m ON m.statement_id = st2.id AND m.deleted_at IS NULL
               AND m.movement_date >= to_date(st2.period || '-01', 'YYYY-MM-DD')
               AND m.movement_date < to_date(st2.period || '-01', 'YYYY-MM-DD') + interval '1 month'
             WHERE st2.id IN (SELECT m2.statement_id FROM finance.bank_movements m2 JOIN bfu34_pares p ON p.md = m2.id)
             GROUP BY st2.id) v
     WHERE st.id = v.id`);
  const despues = (await knex.raw(`SELECT id, total_in, total_out FROM finance.bank_statements WHERE id = ANY(?::uuid[])`, [antes.map((x) => x.id)])).rows;

  await knex.raw(`DROP TABLE IF EXISTS pg_temp.bfu34_pares`);
  for (const b of borrados) console.log(`[BFU.3.4] renglón repetido borrado: ${JSON.stringify(b)}`);
  for (const a of antes) {
    const d = despues.find((x) => x.id === a.id);
    console.log(`[BFU.3.4] ${a.alias} ${a.period}: abonos ${a.total_in} → ${d?.total_in}, cargos ${a.total_out} → ${d?.total_out} (inicial ${a.opening_balance} y final ${a.closing_balance} sin cambio)`);
  }
  console.log(`[BFU.3.4] ${n} pares: ${lineas.rowCount} renglones de la descarga borrados, ${soft.rowCount} movimientos marcados borrados, ` +
    `${movidos.rowCount} pareos del motor pasados al original, ${quitados.rowCount} pareos quitados (el original ya tenía el suyo)`);
};

/**
 * No se deshace: los renglones repetidos se borraron (la tabla no tiene `deleted_at`) y volverlos a meter sería
 * volver a contar dos veces el mismo dinero. Lo borrado quedó impreso completo en la salida del `up`.
 */
exports.down = async function down() {
  throw new Error('[BFU.3.4] no se deshace: volver a meter los renglones repetidos contaría dos veces el mismo dinero (lo borrado está en la salida del up)');
};
