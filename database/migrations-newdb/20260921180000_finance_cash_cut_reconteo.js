/**
 * CG.19 Capa 1b — **El arqueo es CIEGO, y el reconteo deja rastro** (ADR-070).
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 *
 * Se cuenta sin ver el esperado y se revela al guardar. Ver la diferencia converger a cero
 * mientras se teclea convierte el arqueo en una **transcripción del esperado**, no en una medición.
 *
 * ⚠️ Esto **revierte un requisito escrito** (`cash-cut.engine.ts` documentaba que la pantalla debía
 * mostrar la diferencia mientras se cuenta). Se cambia y queda escrito el porqué donde estaba el
 * requisito viejo, para que nadie lo "restaure" pensando que fue un descuido.
 *
 * ⭐ **Y recién ahora sirve de algo.** Antes de la Capa 1, esconder el esperado era teatro: los dos
 * números salían de la misma persona. Con el ingreso anclado a un cobro de Kepler, el esperado es
 * un hecho ajeno al que cuenta.
 *
 * ── El reconteo: UNA vez, con motivo, sin borrar el primero ──────────────────────────────────
 *
 * Un reconteo ilimitado es un ajuste con otro nombre: se cuenta hasta que dé. Uno solo, guardado
 * **junto** al primero y con su razón, deja ver exactamente lo que pasó.
 *
 *   · `conteo_previo`    = el PRIMER conteo, tal cual se capturó (denominaciones + morralla +
 *                          total + cuándo). No se pisa nunca.
 *   · `reconteo_motivo`  = por qué se volvió a contar.
 *
 * Los dos van juntos o ninguno (`cut_reconteo_chk`): un primer conteo guardado sin razón no se
 * distingue de un ajuste, y una razón sin el conteo viejo no se puede auditar.
 *
 * ── ⚠️ Lo que se MIDIÓ antes de construir esto ───────────────────────────────────────────────
 *
 * Ya existe un arqueo ciego en la casa (`reconciliation.blind_counts`, SM.8) y **casi no se usa**:
 * **5 filas en total**, todas del 27-ago al 02-sep de 2026 —la ventana en que se construyó— y nada
 * después. El plan pedía entender por qué antes de calcarlo. La causa **no es el software**:
 *
 *     de 32 cajeros, 8 se loguearon ALGUNA VEZ · 7 en 30 días · 0 en los últimos 7
 *
 * El mecanismo estaba bien; la población para la que se hizo no entra al sistema. El riesgo no se
 * traslada igual acá —la caja general la captura gente de oficina, que sí usa la plataforma— pero
 * son **pocas personas** (1 de tesorería, 3 activos de finanzas_operativo), así que esta capa se
 * declara exitosa con **uso real**, no con que compile.
 *
 * Aditiva e idempotente. No toca ninguna fila existente (`cash_ledger_cuts` no tiene filas de
 * negocio todavía).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('cash_ledger_cuts', col);

  if (!(await tiene('conteo_previo'))) {
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ADD COLUMN conteo_previo jsonb`);
  }
  if (!(await tiene('reconteo_motivo'))) {
    await knex.raw(`ALTER TABLE finance.cash_ledger_cuts ADD COLUMN reconteo_motivo text`);
  }

  // Los dos juntos o ninguno, y el motivo con sustancia (mismo piso que el de cancelación).
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cut_reconteo_chk'
      ) THEN
        ALTER TABLE finance.cash_ledger_cuts
          ADD CONSTRAINT cut_reconteo_chk CHECK (
            (conteo_previo IS NULL AND reconteo_motivo IS NULL)
            OR (conteo_previo IS NOT NULL AND length(btrim(coalesce(reconteo_motivo, ''))) >= 5)
          );
      END IF;
    END $$`);

  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger_cuts.conteo_previo IS
      'CG.19 — El PRIMER conteo del arqueo ciego, cuando hubo reconteo. No se pisa: el punto es poder ver los dos.'`);
  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger_cuts.reconteo_motivo IS
      'CG.19 — Por que se volvio a contar. Sin esto un reconteo no se distingue de un ajuste.'`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cut_reconteo_chk`);
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP COLUMN IF EXISTS reconteo_motivo`);
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP COLUMN IF EXISTS conteo_previo`);
};
