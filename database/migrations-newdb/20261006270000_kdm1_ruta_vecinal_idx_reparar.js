'use strict';
/**
 * `[VEC.5.1]` — **Repara el índice que `20261006260000` dejó INVÁLIDO en prod.**
 *
 * La migración anterior ya quedó registrada (batch 746) y su archivo está corregido para que no
 * vuelva a pasar, pero el objeto en prod quedó mal y una migración registrada no se re-ejecuta.
 * Esto lo arregla, y deja el rastro de por qué hizo falta.
 *
 * ── La trampa, que no avisa ─────────────────────────────────────────────────────────────────
 *
 * El primer `CREATE INDEX CONCURRENTLY` caducó por `lock_timeout` — esperable sobre `kdm1`, que
 * el CDC escribe cada minuto. Lo que no es esperable es lo que deja atrás: un índice con
 * **`indisvalid = false`**, que existe en el catálogo, ocupa espacio y **el planner nunca usa**.
 *
 * Y entonces el reintento, que llevaba `IF NOT EXISTS`, lo dio por hecho:
 *
 *     OK → [746,["20261006260000_kdm1_ruta_vecinal_idx.js"]] · 0.1 s
 *
 * **0.1 s para indexar 555 MB.** El único síntoma de que no se había construido nada era el
 * tiempo — la migración reportó éxito, el batch avanzó, y la consulta siguió igual de lenta.
 * Es la misma familia de fallo que esta casa ya documentó en otro contexto: *no falla, triunfa
 * en el lugar equivocado*. Por eso el chequeo que importa no es "¿existe el índice?" sino
 * "¿está **válido**?".
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false }; // CONCURRENTLY no corre en transacción

const IDX = 'ix_kdm1_ruta_vecinal';

exports.up = async function up(knex) {
  const roto = (await knex.raw(
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ? AND i.indisvalid = false`, [IDX])).rows.length > 0;
  if (!roto) return; // ya está válido: nada que reparar

  // El `SET` va ANTES del `DROP`: también él hace cola detrás del CDC, y con el `lock_timeout`
  // corto del aplicador caduca igual que el `CREATE`.
  await knex.raw(`SET lock_timeout = '90s'`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IDX}`);
  await knex.raw(
    `CREATE INDEX CONCURRENTLY ${IDX}
         ON kepler_ods.kdm1 (btrim(COALESCE(c12, '')), ((c9)::date))
      WHERE c2 = 'U' AND c3 = 'D' AND btrim(COALESCE(c12, '')) ~ '^[0-9]V[0-9]'`);

  const ok = (await knex.raw(
    `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ?`, [IDX])).rows[0];
  if (!ok || ok.indisvalid !== true) {
    throw new Error(`[VEC.5.1] ${IDX} sigue inválido: el índice no se construyó y la consulta seguirá lenta`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IDX}`);
};
