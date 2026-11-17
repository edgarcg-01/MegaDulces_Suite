'use strict';
/**
 * `[PGP.123]` G.UI.1e — **Cerrar el caso de una cancelada: quién la revisó, cuándo y qué se hizo.** Francisco,
 * 2026-11-16: «la Suite lo contesta sola y una persona lo confirma». Plan: anexo G §14.8
 * (`docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md`).
 *
 * «Canceladas en Kepler» (G.UI.1c) lista los vales comprobados cuya solicitud Kepler canceló, y hasta hoy nada las daba
 * por revisadas: se quedaban ahí para siempre. Tres columnas en el vale (`finance.expense_proofs`; ADR-056: la revisión
 * es del vale, no se inventa otra tabla), las tres opcionales:
 *  · `kepler_cancel_reviewed_at` — cuándo se cerró el caso;
 *  · `kepler_cancel_reviewed_by` — quién (el nombre del padrón, como `validated_by`);
 *  · `kepler_cancel_note` — qué se hizo o por qué se queda así (de 3 a 500 letras).
 * Ligar el vale a su recaptura NO usa estas columnas: cambia su folio y la auditoría va en `capture_meta.religado`, como
 * el casamiento de GX.9 (`casado_por`).
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-16) ──
 *  · 43 vales validados con la solicitud cancelada en Kepler: 29 con su gasto generado y 14 sin él.
 *  · `finance.expense_proofs` no tiene ninguna columna `kepler_cancel_*`.
 *
 * Columnas nulas sin DEFAULT: `ADD COLUMN` es sólo metadatos y ningún camino de inserción cambia (regla 14: no hay
 * NOT NULL). El CHECK exige las tres juntas (o ninguna) y la nota de 3 a 500 letras; las filas de hoy, todas en NULL,
 * lo cumplen.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pgp123_canceladas_revisadas]';
const CHECK = ['expense_proofs_kepler_cancel_review_ck',
  `(kepler_cancel_reviewed_at IS NULL AND kepler_cancel_reviewed_by IS NULL AND kepler_cancel_note IS NULL)
   OR (kepler_cancel_reviewed_at IS NOT NULL AND kepler_cancel_reviewed_by IS NOT NULL
       AND coalesce(char_length(btrim(kepler_cancel_note)) BETWEEN 3 AND 500, false))`];
// ⚠️ `coalesce(…, false)`: con la nota NULL, `char_length(NULL)` da NULL, el BETWEEN da NULL y un CHECK que da NULL NO falla
// (la revisión independiente lo encontró el 2026-11-17; G.6 ya lo había aprendido con el folio).

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const columnas = [['kepler_cancel_reviewed_at', (t) => t.timestamp('kepler_cancel_reviewed_at', { useTz: true })],
    ['kepler_cancel_reviewed_by', (t) => t.text('kepler_cancel_reviewed_by')], ['kepler_cancel_note', (t) => t.text('kepler_cancel_note')]];
  for (const [col, crear] of columnas) {
    if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', col))) {
      await knex.schema.withSchema('finance').alterTable('expense_proofs', crear);
      console.log(`${TAG} + finance.expense_proofs.${col}`);
    }
  }
  // Se rearma siempre (como G.6): una base con la versión anterior del CHECK queda con la de hoy.
  const [nombre, regla] = CHECK;
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS ${nombre}`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT ${nombre} CHECK (${regla})`);
  console.log(`${TAG} = ${nombre}`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.kepler_cancel_reviewed_at IS '[PGP.123] G.UI.1e: cuándo se cerró el caso de la solicitud cancelada en Kepler (opcional)'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.kepler_cancel_reviewed_by IS '[PGP.123] G.UI.1e: quién cerró el caso de la solicitud cancelada (opcional)'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.kepler_cancel_note IS '[PGP.123] G.UI.1e: qué se hizo con la solicitud cancelada o por qué se queda así, 3 a 500 letras (opcional)'`);
};

/**
 * Quita el CHECK y DEJA las columnas: lo que escribió una persona al cerrar el caso no lo tira un `down` (mismo criterio
 * que G.6, S.13 y S.17). Re-aplicar el `up` las encuentra y vuelve a poner el CHECK.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS ${CHECK[0]}`);
  console.log(`${TAG} - ${CHECK[0]} (las columnas se quedan)`);
};
