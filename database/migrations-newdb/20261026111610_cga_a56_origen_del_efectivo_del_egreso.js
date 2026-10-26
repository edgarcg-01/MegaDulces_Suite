'use strict';
/**
 * `[CGA-A.56]` — Cada egreso de Caja General dice DE DÓNDE salió el efectivo: de uno o varios
 * retiros de CAOS, o del cajón.
 *
 * Edgar, 2026-10-26: *«agreguemos una opción donde todo egreso se vincule a un movimiento de
 * CAOS»*, y eligió que también se pueda declarar «salió del cajón» (la morralla y lo que se paga
 * con el efectivo de los cobros no viene de la máquina; sin esa opción se ligaría cualquier retiro
 * con tal de guardar).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-26) ────────────────────────────────────────
 *  · 334 gastos en el libro (desde el 25-sep); 31 enlazados a un retiro. Del resto no se sabe si
 *    salieron de la máquina o del cajón — y de eso depende el corte (ADR-101).
 *  · Un solo `insert` en `finance.cash_ledger` (`CashLedgerService.create`), al que llegan la
 *    captura, el lote (`crearLote`) y el autollenado.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `finance.cash_ledger.origen_efectivo` (`caos` | `cajon`), NULLABLE: lo viejo no lo dice y no se
 *  inventa. Que sea obligatorio lo decide el servicio desde `CAJA_EGRESO_ORIGEN_DESDE` (apagado
 *  hasta que Edgar fije el día), igual que los otros frenos de la caja.
 *
 * Idempotente. ⛔ Ni un `?` en el SQL.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasColumn('cash_ledger', 'origen_efectivo'))) {
    await knex.raw(`ALTER TABLE finance.cash_ledger ADD COLUMN origen_efectivo text`);
  }
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_origen_efectivo_chk`);
  await knex.raw(`ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_origen_efectivo_chk
    CHECK (origen_efectivo IS NULL OR origen_efectivo IN ('caos', 'cajon'))`);
  await knex.raw(`COMMENT ON COLUMN finance.cash_ledger.origen_efectivo IS
    '[CGA-A.56] De dónde salió el efectivo de un egreso: caos (retiros enlazados en caos_cash_links) o cajon. NULL = no se dijo (anterior al 2026-10-26).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_origen_efectivo_chk`);
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP COLUMN IF EXISTS origen_efectivo`);
};
