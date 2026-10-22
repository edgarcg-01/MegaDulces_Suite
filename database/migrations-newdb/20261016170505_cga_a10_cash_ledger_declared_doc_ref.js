'use strict';
/**
 * ⭐⭐ `[CGA-A.10]` — **`finance.cash_ledger.declared_doc_ref`: la captura declara el documento
 * en una COLUMNA, no en la prosa.** Es la solución de fondo al incidente del 2026-10-16; el
 * `[CGA-A.9]` de ese día fue la contención.
 *
 * ── Qué estaba mal ─────────────────────────────────────────────────────────────────────────
 *
 * El descuento anti-duplicado de `movimientosPendientes()` compara
 * `glosa LIKE doc_tipo || ' ' || folio || '%'`. **`doc_tipo + folio` no identifica un cobro:**
 * el folio de camioneta es consecutivo **por unidad**, no global, así que dos unidades comparten
 * folio el mismo día de forma rutinaria. Cada captura tapaba a sus homónimos de otras
 * sucursales: **157 movimientos · $1,325,687.43**. `GOTCHAS` §86.
 *
 * `[CGA-A.9]` acotó el descuento a `origen_tipo = 'caos'` —lo único para lo que existía— y
 * recuperó 141. Quedaron **16 · $211,548.14**: capturas desde CAOS que chocan **entre sí**.
 * Ese resto no se cierra con un filtro mejor. Se cierra **dándole una llave a la declaración**.
 *
 * ── Qué hace esta migración ────────────────────────────────────────────────────────────────
 *
 * 1. Agrega `declared_doc_ref text NULL`: la identidad COMPLETA del documento que esa captura
 *    dice estar pagando, con la misma forma que `origen_ref` del lado de Kepler —
 *    `sucursal|doc_tipo|folio|clave_banco`, p.ej. `01-005|U-A-5|0000015|0011`.
 *    **Aditiva y nullable**: nada se rompe, el código viejo la ignora.
 * 2. Índice parcial para que el descuento por llave no escanee.
 * 3. **Rellena sólo lo que NO tiene ambigüedad.** Para cada captura de CAOS cuya glosa declara
 *    un documento, se cuenta cuántas filas de la cola casan con ese `doc_tipo + folio`:
 *    si es **exactamente una**, la llave es esa y se escribe. Si hay dos o más, **se deja en
 *    NULL** — no se adivina. Medido en prod el 2026-10-16, antes de escribir esto:
 *
 *        1 candidato  →  7 capturas  ·  $56,185.00   ← se rellenan
 *        2 candidatos →  4 capturas  ·  $57,865.00   ← quedan NULL
 *        7 candidatos →  1 captura   ·  $22,676.00   ← queda NULL
 *
 *    O sea: **5 capturas · $80,541.00 necesitan que una persona diga a qué documento van.**
 *    Eso es el hueco de §86 con nombre y monto, y no lo cierra una migración: lo cierra la
 *    pantalla de captura pidiendo el documento (`[CGA-A.10b]`, pendiente).
 *
 * ⚠️ El relleno se guarda a sí mismo: cuenta los candidatos **al correr**, no confía en los
 *    números de arriba. Si la ambigüedad cambió, escribe menos y lo dice — nunca de más.
 *
 * ⚠️ Crea un objeto de esquema **y** mueve filas. Igual conviene aplicarla a mano y mirar el
 *    conteo que imprime.
 *
 * Idempotente: `hasColumn` antes de agregar, e `IF NOT EXISTS` en el índice; el relleno sólo
 * toca filas con `declared_doc_ref IS NULL`.
 *
 * @param { import("knex").Knex } knex
 */

const COL = 'declared_doc_ref';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const existe = await knex.schema.withSchema('finance').hasColumn('cash_ledger', COL);
  if (!existe) {
    await knex.schema.withSchema('finance').alterTable('cash_ledger', (t) => {
      t.text(COL).nullable();
    });
  }

  // ⛔ `COMMENT ON` NO acepta parámetros ligados (GOTCHAS §51): literal con comillas escapadas.
  await knex.raw(
    `COMMENT ON COLUMN finance.cash_ledger.declared_doc_ref IS ` +
    `'[CGA-A.10] Identidad COMPLETA del documento que esta captura declara pagar, con la misma ` +
    `forma que origen_ref: sucursal|doc_tipo|folio|clave_banco. Reemplaza al LIKE sobre glosa, ` +
    `que no identificaba nada porque el folio de camioneta es consecutivo POR UNIDAD. NULL = la ` +
    `captura no declaró documento, o lo declaró de forma ambigua y falta que una persona lo diga. ` +
    `Ver GOTCHAS §86.'`);

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ix_cash_ledger_declared_doc
       ON finance.cash_ledger (tenant_id, declared_doc_ref)
      WHERE declared_doc_ref IS NOT NULL AND deleted_at IS NULL`);

  // ── Relleno: SÓLO lo que no tiene ambigüedad ──────────────────────────────────────────────
  //
  // La cola es por tenant y la vista exige `app.tenant_id`, así que se recorre tenant por
  // tenant. Hoy hay uno; mañana puede haber más y esto no se rompe.
  const { rows: tenants } = await knex.raw(
    `SELECT DISTINCT tenant_id FROM finance.cash_ledger
      WHERE origen_tipo = 'caos' AND deleted_at IS NULL AND estado <> 'cancelado'
        AND declared_doc_ref IS NULL
        AND glosa ~ '^[A-Z]-[A-Z]-[0-9]+ [0-9]+'`);

  let escritas = 0;
  let ambiguas = 0;

  for (const { tenant_id: tid } of tenants) {
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tid]);

    const { rows: candidatos } = await knex.raw(
      `WITH decl AS (
         SELECT l.id,
                substring(l.glosa from '^([A-Z]-[A-Z]-[0-9]+) ')   AS d_tipo,
                substring(l.glosa from '^[A-Z]-[A-Z]-[0-9]+ ([0-9]+)') AS d_folio
           FROM finance.cash_ledger l
          WHERE l.tenant_id = ? AND l.origen_tipo = 'caos'
            AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
            AND l.declared_doc_ref IS NULL
            AND l.glosa ~ '^[A-Z]-[A-Z]-[0-9]+ [0-9]+')
       SELECT d.id,
              (SELECT count(*) FROM finance.v_caja_movimientos_pendientes v
                WHERE v.tenant_id = ? AND v.doc_tipo = d.d_tipo AND v.folio = d.d_folio) AS n,
              (SELECT min(v.origen_ref) FROM finance.v_caja_movimientos_pendientes v
                WHERE v.tenant_id = ? AND v.doc_tipo = d.d_tipo AND v.folio = d.d_folio) AS ref
         FROM decl d`,
      [tid, tid, tid]);

    for (const c of candidatos) {
      if (Number(c.n) !== 1 || !c.ref) { ambiguas++; continue; }
      const r = await knex.raw(
        `UPDATE finance.cash_ledger SET declared_doc_ref = ?, updated_at = now()
          WHERE id = ? AND declared_doc_ref IS NULL`,
        [c.ref, c.id]);
      escritas += r.rowCount || 0;
    }
  }

  console.log(`[CGA-A.10] declared_doc_ref: ${escritas} captura(s) resueltas sin ambigüedad.`);
  if (ambiguas) {
    console.log(`[CGA-A.10] ⚠️ ${ambiguas} captura(s) quedan en NULL: su doc_tipo+folio casa con ` +
      `más de un documento. Las resuelve una persona desde la pantalla, no una migración.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_cash_ledger_declared_doc`);
  const existe = await knex.schema.withSchema('finance').hasColumn('cash_ledger', COL);
  if (existe) {
    // Al soltar la columna se va el relleno con ella: no hay que revertirlo aparte.
    await knex.schema.withSchema('finance').alterTable('cash_ledger', (t) => { t.dropColumn(COL); });
  }
};
