'use strict';
/**
 * `[BFU.2.10]` — `bank_movements.classified_by` admite 'documento': la categoría la dio el documento de Kepler con que
 * el motor de conciliación casó el renglón de la descarga (`categoria-del-documento.ts`).
 *
 * ── Lo medido antes (sólo lectura, pg-prod, 2026-11-20) ─────────────────────────────────────
 *  · 265 movimientos de noviembre sin categoría, todos retiros; 145 ya casados con su documento de Kepler, que nunca
 *    se usaba para categorizar (la categoría se pone al entrar la descarga, antes del pareo).
 *  · El CHECK admite 'rule' | 'manual' | 'banco'. 'documento' es una procedencia distinta de 'banco' (el texto del
 *    banco) a propósito: si el pareo cambia o se va, la categoría que vino del documento se recalcula; la del texto no.
 *
 * Aditiva e idempotente: el CHECK sólo AGREGA un valor permitido; la API desplegada no lo usa todavía y no se entera.
 * ⚠️ Va ANTES de desplegar el código que escribe 'documento' (si no, el motor falla al escribir la categoría).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_movements_classified_by_check'
                      AND pg_get_constraintdef(oid) LIKE '%documento%') THEN
        ALTER TABLE finance.bank_movements DROP CONSTRAINT IF EXISTS bank_movements_classified_by_check;
        ALTER TABLE finance.bank_movements ADD CONSTRAINT bank_movements_classified_by_check
          CHECK (classified_by = ANY (ARRAY['rule'::text, 'manual'::text, 'banco'::text, 'documento'::text]));
      END IF;
    END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: sólo si ningún renglón usa 'documento' (si no, se frena y lo dice). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [r] } = await knex.raw(`SELECT count(*)::int n FROM finance.bank_movements WHERE classified_by = 'documento'`);
  if (r.n > 0) throw new Error(`[BFU.2.10] ${r.n} movimientos tienen la categoría de su documento: no se puede quitar el valor sin perderla`);
  await knex.raw(`
    ALTER TABLE finance.bank_movements DROP CONSTRAINT IF EXISTS bank_movements_classified_by_check;
    ALTER TABLE finance.bank_movements ADD CONSTRAINT bank_movements_classified_by_check
      CHECK (classified_by = ANY (ARRAY['rule'::text, 'manual'::text, 'banco'::text]))`);
};
