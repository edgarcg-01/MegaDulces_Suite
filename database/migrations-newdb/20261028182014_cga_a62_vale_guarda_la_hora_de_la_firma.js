'use strict';
/**
 * `[CGA-A.62]` — El vale de gasto guarda CUÁNDO y QUIÉN lo aprobó.
 *
 * Edgar, 2026-10-28: *«hay que revisar que los /finanzas/aprobacion-gastos que pasen por aquí
 * hayan estado aprobados antes de mencionar el pago»*. Para eso hace falta la hora de la firma, y
 * `finance.expense_proofs` no la tiene: `approve()` sólo llena `validated_at` cuando el vale CIERRA
 * al aprobarse; si queda `aprobada` (falta la evidencia), la hora de la firma no queda en ningún
 * lado — ni columna, ni trigger, ni bitácora (sólo un aviso por socket y un renglón de log).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-28) ────────────────────────────────────────
 *  · Pagos X-D-26 contra la 0011 desde el 1-oct que casan con su solicitud X-A-15-1 (misma
 *    sucursal, importe y beneficiario; solicitud antes del pago): 420 de 1,014 · placebo +$1: 7.
 *  · De sus vales aprobados, **246 no dicen cuándo se firmaron**: no se puede saber si fue antes o
 *    después del pago. Desde esta migración sí.
 *
 * Columnas NULLABLES y sin backfill, a propósito: la hora de las firmas viejas no se conoce, y un
 * relleno con `validated_at` afirmaría una hora que no es (`validated_at` es el cierre, y en los
 * cierres de Kepler ni siquiera es una persona). Lo viejo se declara «sin hora de firma».
 *
 * Idempotente. Sólo agrega dos columnas nulas: no reescribe la tabla.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN IF NOT EXISTS aprobado_at timestamptz`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN IF NOT EXISTS aprobado_por text`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.aprobado_at IS
    '[CGA-A.62] Cuándo se aprobó el vale en /finanzas/aprobacion-gastos (recibida → aprobada/validada). NULL en los aprobados antes del 2026-10-28: esa hora no se guardaba. No es validated_at (el cierre).'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.aprobado_por IS
    '[CGA-A.62] Quién aprobó el vale (el mismo actor que approve() registra). NULL en los aprobados antes del 2026-10-28.'`);
  const { rows: [r] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE status IN ('aprobada','validada','revision'))::int AS aprobados
      FROM finance.expense_proofs`);
  console.log(`[CGA-A.62] expense_proofs: aprobado_at/aprobado_por listas · ${r.aprobados} vales aprobados quedan «sin hora de firma» (no se rellenan)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS aprobado_por`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS aprobado_at`);
};
