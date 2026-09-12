/**
 * DROP de 5 tablas COPIA/RESPALDO — el anti-patrón que el proyecto prohíbe (nunca copiar tablas).
 *
 * Todas verificadas contra prod 2026-09-11: nombre de respaldo (`_bak` / `_backup_FECHA` /
 * `_dedup_backup_FECHA`) + **CERO referencias en código vivo** (apps/libs/importers/services).
 * Son residuos de operaciones puntuales (normalización de productos, dedup, snapshots de bancos)
 * que quedaron ocupando espacio y ensuciando el esquema. No las lee nada.
 *
 *   analytics.bank_postings_snapshot_bak           (31 MB, ~45k filas)
 *   analytics.kepler_bank_movements_snapshot_bak   (23 MB, ~56k filas)
 *   public.products_normalize_backup_20260528      (8 MB,  ~1420 filas)
 *   identity.products_dedup_backup_20260716        (1.7 MB, ~1927 filas)
 *   identity.brands_dedup_backup_20260716          (8 KB,  ~61 filas)
 *
 * DROP ... IF EXISTS, SIN CASCADE (nada debería depender de un respaldo; si algo depende, que
 * falle ruidoso en vez de arrastrar). Idempotente. `down` = no-op (no se recrea un respaldo).
 * NO aplicada a prod actual (el clasificador frena los DROP masivos); se aplica con migrate:latest
 * en el server nuevo.
 * @param { import("knex").Knex } knex
 */
const BACKUPS = [
  'analytics.bank_postings_snapshot_bak',
  'analytics.kepler_bank_movements_snapshot_bak',
  'public.products_normalize_backup_20260528',
  'identity.products_dedup_backup_20260716',
  'identity.brands_dedup_backup_20260716',
];

exports.up = async function (knex) {
  for (const t of BACKUPS) {
    await knex.raw(`DROP TABLE IF EXISTS ${t}`);
    console.log(`  DROP ${t}`);
  }
};

exports.down = async function () {
  // Respaldos residuales: no se recrean. No-op a propósito.
};
