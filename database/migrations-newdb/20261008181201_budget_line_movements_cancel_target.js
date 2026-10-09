'use strict';
/**
 * `[PU.VG.4a]` — hacer RECONSTRUIBLE el ledger de egresos: `cancel_target` y `from_reserva`.
 *
 * ── Los DOS defectos, que son el mismo ──────────────────────────────────────────────────────
 * El estado de una partida (`reserved_amount`, `committed_amount`, …) lo lleva la fila de
 * `budget_lines`, y `line_movements` es el libro que debería permitir **recomputarlo**. Hoy no
 * se puede, por dos transiciones que el libro no registra:
 *
 *  1. **`cancelacion`** — `cancelar(lineId, target, …)` decide con `target` cuál acumulador baja,
 *     `reserved` o `committed` (`budget-lines.service.ts`). Pero el movimiento dice sólo
 *     `movement_type = 'cancelacion'`: el objetivo viaja **únicamente en `note`**, texto libre que
 *     el llamador puede reemplazar (`note: opts.note ?? …`).
 *  2. **`compromiso` con `fromReserva`** — ese camino hace `reserved -= amt` y `committed += amt`,
 *     o sea **mueve** entre buckets; sin él, `committed += amt` sale del disponible y `reserved` no
 *     se toca. Los dos escriben un movimiento idéntico. Dado un `compromiso`, nada dice cuál fue.
 *
 * Consecuencia: `reserved_amount` y `committed_amount` **NO se pueden recomputar** desde el
 * ledger, que es justo el único cuadre que puede fallar — el obvio
 * (`vigente − (res+com+eje) = disponible`) es una **tautología**, porque `available_amount` no es
 * columna: se calcula con esa misma resta.
 *
 * ⛔ Y la columna que habría servido ya existía y está MUERTA: `reverses_movement_id` se creó en
 *    `20260917140000` y **no se escribe en ninguna parte del repo** (grep sobre todo `*.ts`: cero
 *    referencias). Esta migración no la revive — una columna que nadie llenó en un mes no es el
 *    mecanismo, es un recordatorio.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 2026-10-08) ──────────────────────────────────────
 *  · `budget.line_movements` = **139 filas y las 139 son `apertura`**.
 *  · `cancelacion` = **0 filas**. Igual `reserva`, `compromiso`, `ejercido`, `pago`, `ampliacion`,
 *    `reduccion`, `transferencia_in` y `transferencia_out`.
 *
 * ⭐ **Por eso se hace HOY.** Con cero cancelaciones el CHECK no puede fallar y no hay nada que
 * rellenar. En cuanto exista la primera, ya no se puede saber retroactivamente qué revirtió: el
 * dato no está en ningún lado. La ventana para arreglarlo gratis se cierra con el primer uso real
 * del ledger.
 *
 * ── La forma ────────────────────────────────────────────────────────────────────────────────
 * `cancel_target` es NULL para todo movimiento que no sea cancelación, y OBLIGATORIO para las que
 * sí. El CHECK lo exige en las dos direcciones: ni una cancelación sin objetivo, ni un objetivo
 * colgado de un movimiento que no cancela nada. Dos ausencias distintas no se escriben igual
 * (ADR-056): acá NULL significa «no aplica», no «no sé».
 *
 * `from_reserva` es booleano NOT NULL con default `false`, y sólo un `compromiso` puede traerlo en
 * `true`. Va booleano y no nullable a propósito: para los 139 movimientos que ya existen —todos
 * `apertura`— `false` es **cierto**, no una suposición; ninguno movió una reserva porque no hay
 * ninguna reserva en todo el ledger.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('budget').hasColumn('line_movements', 'cancel_target'))) {
    await knex.raw(`ALTER TABLE budget.line_movements ADD COLUMN cancel_target text`);
  }
  if (!(await knex.schema.withSchema('budget').hasColumn('line_movements', 'from_reserva'))) {
    await knex.raw(`ALTER TABLE budget.line_movements
                      ADD COLUMN from_reserva boolean NOT NULL DEFAULT false`);
  }

  // El CHECK se agrega aparte y con guarda: si alguien ya lo creó, no se duplica.
  const yaEsta = await knex.raw(`
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'budget.line_movements'::regclass AND conname = 'ck_budget_mov_cancel_target'`);
  if (!yaEsta.rows.length) {
    // ⚠️ NOT VALID + VALIDATE por separado: el VALIDATE toma un lock más suave que el ADD. Con 139
    // filas da igual, pero la tabla sólo crece y el patrón tiene que quedar bien desde ahora.
    await knex.raw(`
      ALTER TABLE budget.line_movements
        ADD CONSTRAINT ck_budget_mov_cancel_target CHECK (
          (movement_type <> 'cancelacion' AND cancel_target IS NULL)
          OR
          (movement_type =  'cancelacion' AND cancel_target IN ('reserva','compromiso'))
        ) NOT VALID`);
    await knex.raw(`ALTER TABLE budget.line_movements VALIDATE CONSTRAINT ck_budget_mov_cancel_target`);
  }

  const yaEstaFR = await knex.raw(`
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'budget.line_movements'::regclass AND conname = 'ck_budget_mov_from_reserva'`);
  if (!yaEstaFR.rows.length) {
    await knex.raw(`
      ALTER TABLE budget.line_movements
        ADD CONSTRAINT ck_budget_mov_from_reserva CHECK (
          movement_type = 'compromiso' OR from_reserva = false
        ) NOT VALID`);
    await knex.raw(`ALTER TABLE budget.line_movements VALIDATE CONSTRAINT ck_budget_mov_from_reserva`);
  }

  await knex.raw(`COMMENT ON COLUMN budget.line_movements.cancel_target IS
    'Que acumulador bajo esta cancelacion: reserva | compromiso. NULL = no aplica (el movimiento no es una cancelacion), nunca "no se". Sin esto, reserved_amount y committed_amount no se pueden recomputar desde el ledger y el unico cuadre que puede fallar queda sin arbitro. [PU.VG.4a]'`);
  await knex.raw(`COMMENT ON COLUMN budget.line_movements.from_reserva IS
    'true = este compromiso MOVIO una reserva previa (reserved baja, committed sube); false = salio del disponible y reserved no se toco. Solo un compromiso puede traerlo en true. Los dos caminos escribian un movimiento identico, asi que sin esta columna reserved_amount no se puede recomputar desde el ledger. [PU.VG.4a]'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE budget.line_movements DROP CONSTRAINT IF EXISTS ck_budget_mov_cancel_target`);
  await knex.raw(`ALTER TABLE budget.line_movements DROP CONSTRAINT IF EXISTS ck_budget_mov_from_reserva`);
  if (await knex.schema.withSchema('budget').hasColumn('line_movements', 'cancel_target')) {
    await knex.raw(`ALTER TABLE budget.line_movements DROP COLUMN cancel_target`);
  }
  if (await knex.schema.withSchema('budget').hasColumn('line_movements', 'from_reserva')) {
    await knex.raw(`ALTER TABLE budget.line_movements DROP COLUMN from_reserva`);
  }
};
