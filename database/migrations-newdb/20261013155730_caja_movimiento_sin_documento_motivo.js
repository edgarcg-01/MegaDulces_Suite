'use strict';
/**
 * ⭐⭐ `[CG.124]` — **Por qué este movimiento de caja no tiene documento.**
 *
 * Edgar, por tercera vez: *"aún salen capturas a mano y te mencioné que todas deben estar
 * conciliadas con un movimiento"*.
 *
 * ── Lo medido en prod (2026-10-13) ──────────────────────────────────────────────────────────
 *
 * De 59 movimientos vivos, **6 sin `origen_ref`**, y se parten en dos causas que **no se arreglan
 * igual**:
 *
 *   (a) DOS eligieron documento y PERDIERON el enlace. La glosa lo prueba, porque la arma el
 *       sistema al elegir de la bandeja:
 *         CG-2026-00006  $6,303.00   "X-D-26 0000161 · GUILLERMO LOPEZ GUTIERREZ"  (real: $6,302.78)
 *         CG-2026-00028 $10,490.00   "X-D-26 0023047 · GASTOS GENERALES OFICINAS"  (real: $1,250.00)
 *       ⛔ Y los dos documentos **siguen ofreciéndose en la bandeja**: se pueden capturar otra vez.
 *
 *   (b) CUATRO no tenían a qué enlazarse: los ingresos "VENTA 08/10" son las rutas 501/502/503 de
 *       Canindo, y **no existe cobro `U-A-5` en Kepler** por esos importes (buscado del 05 al
 *       14-oct, en caja y en banco) ni depósito de CAOS que cuadre.
 *
 * ── Qué hace esta columna, y qué NO ─────────────────────────────────────────────────────────
 *
 * El caso (a) lo bloquea el motor `caja-conciliacion.engine.ts` sin necesidad de guardar nada: si
 * la glosa nombra un documento y el enlace no llegó, no se guarda.
 *
 * El caso (b) es dinero REAL que entró y hay que poder registrarlo. Esta columna es el lugar donde
 * se dice **por qué** no hay documento. ⛔ No es un campo de trámite: el motor exige **≥12
 * caracteres**, y el CHECK de acá lo vuelve a exigir en la base — una validación que sólo vive en
 * el servicio se saltea por cualquier otro camino de escritura.
 *
 * ⚠️ **No se vuelve obligatoria para todos**, a propósito: un movimiento CON `origen_ref` no la
 * necesita, y exigirla ahí sería pedir que se explique lo que ya está explicado.
 *
 * ⚠️ **Los 6 que ya están NO se tocan.** Rellenarlos con un motivo inventado sería exactamente lo
 * que esta columna existe para impedir. Se quedan sin motivo y a la vista; el que los capturó es
 * quien sabe por qué.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasColumn('cash_ledger', 'sin_documento_motivo'))) {
    await knex.raw(`ALTER TABLE finance.cash_ledger ADD COLUMN sin_documento_motivo text`);
  }

  /**
   * ⛔ El CHECK admite `NULL` (lo normal: el movimiento está enlazado) y exige largo cuando hay
   * algo escrito. Lo que NO admite es la cadena vacía ni "ok": un motivo que no se puede auditar
   * dentro de seis meses no es un motivo, es un trámite para pasar la compuerta.
   */
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cash_ledger_sin_doc_motivo_chk'
      ) THEN
        ALTER TABLE finance.cash_ledger
          ADD CONSTRAINT cash_ledger_sin_doc_motivo_chk
          CHECK (sin_documento_motivo IS NULL OR length(btrim(sin_documento_motivo)) >= 12)
          NOT VALID;
      END IF;
    END $$`);

  /**
   * ⚠️ `NOT VALID` y luego `VALIDATE` en un paso aparte: así el `ALTER` no toma un lock de tabla
   * mientras revisa las filas que ya están. Con la tabla chica da igual, pero el molde tiene que
   * ser el correcto desde el principio — esta tabla crece todos los días.
   */
  await knex.raw(`ALTER TABLE finance.cash_ledger VALIDATE CONSTRAINT cash_ledger_sin_doc_motivo_chk`);

  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger.sin_documento_motivo IS
      '[CG.124] Por que este movimiento NO se pudo enlazar a un documento de Kepler ni a CAOS. Minimo 12 caracteres (CHECK). NULL = esta enlazado, que es lo normal. El caso real: las rutas 501/502/503 de Canindo, cuyo cobro no existe en Kepler.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_sin_doc_motivo_chk`);
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP COLUMN IF EXISTS sin_documento_motivo`);
};
