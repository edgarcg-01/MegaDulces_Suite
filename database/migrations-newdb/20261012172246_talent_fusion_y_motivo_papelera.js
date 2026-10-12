'use strict';
/**
 * `[RH.2.2]` Reclutamiento — dos columnas que pide la API: por qué está un candidato en la papelera y,
 * si llegó ahí por una fusión, en quién se fusionó.
 *
 * ── Por qué una migración aparte ───────────────────────────────────────────────────────────
 * Iban dentro de `20261012155411_talent_reclutamiento_datos`, pero esa migración entró a `main` (#378)
 * en su versión anterior y ya pudo aplicarse en alguna base. Una migración aplicada no se reescribe.
 *
 * ── La decisión ────────────────────────────────────────────────────────────────────────────
 * FUSIONAR dos registros de la misma persona NO mueve su historia, como hacía Mega Talento
 * (`UPDATE candidatos_eventos SET candidato_id=…`): la bitácora de etapas y los eventos son de sólo
 * agregar para la app. El absorbido va a la papelera con `merged_into_id` y la ficha junta las dos
 * historias; restaurarlo deshace la fusión.
 *
 * ── Lo medido antes ────────────────────────────────────────────────────────────────────────
 *  · La prueba contra la base destapó que `merged_into_id IS NULL OR deletion_reason = 'fusionado'`
 *    DEJABA PASAR un `merged_into_id` sin papelera: con `deletion_reason` NULL la comparación da NULL y
 *    un CHECK con NULL no rechaza. Por eso el `coalesce`.
 *  · `talent.candidates` no tiene consumidores fuera de la API de esta misma entrega: si hubiera filas
 *    en la papelera, se les pone `manual` antes del CHECK (es lo que era: Mega Talento no distinguía).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'talent.candidates';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('talent').hasColumn('candidates', 'deletion_reason'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN deletion_reason text
      CHECK (deletion_reason IS NULL OR deletion_reason IN ('manual','cierre_seguimiento','fusionado'))`);
  }
  if (!(await knex.schema.withSchema('talent').hasColumn('candidates', 'merged_into_id'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN merged_into_id uuid`);
  }
  await knex.raw(`UPDATE ${T} SET deletion_reason = 'manual' WHERE deleted_at IS NOT NULL AND deletion_reason IS NULL`);

  const existe = async (nombre) => (await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'talent.candidates'::regclass`, [nombre])).rows.length > 0;
  if (!(await existe('candidates_merged_into_fk'))) {
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT candidates_merged_into_fk
      FOREIGN KEY (tenant_id, merged_into_id) REFERENCES ${T} (tenant_id, id)`);
  }
  if (!(await existe('candidates_trash_ck'))) {
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT candidates_trash_ck CHECK ((deleted_at IS NULL) = (deletion_reason IS NULL))`);
  }
  if (!(await existe('candidates_merge_ck'))) {
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT candidates_merge_ck CHECK (
      merged_into_id IS NULL OR (coalesce(deletion_reason, '') = 'fusionado' AND merged_into_id <> id))`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_talent_cand_merged ON ${T} (tenant_id, merged_into_id) WHERE merged_into_id IS NOT NULL`);
  await knex.raw(`COMMENT ON COLUMN ${T}.merged_into_id IS 'Si está en la papelera por una fusión: el registro que lo absorbió. Su historia se lee desde la ficha de ése; restaurarlo deshace la fusión.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS talent.ix_talent_cand_merged`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS candidates_merge_ck`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS candidates_trash_ck`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS candidates_merged_into_fk`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS merged_into_id`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS deletion_reason`);
};
