/**
 * SM.23 — El arqueo de la SANGRÍA.
 *
 * `blind_counts.tipo` solo admitía `cierre` y `relevo`, y con eso el conteo cubría
 * el cajón al cerrar. El problema, medido sobre 919 cortes: **entre el 63% y el 81%
 * del efectivo no está ahí** — sale durante el turno en retiros, cada vez que la
 * caja junta su límite (`kdpv_folio_caja.c46`, típicamente $15,000 y el valor que
 * las cajeras reconocen). Al cerrar quedan ~$9,000 de $27,000 cobrados.
 *
 * O sea que contar solo al cierre verifica un tercio del dinero. Los otros dos
 * tercios salieron sin que exista registro de qué billetes eran: Kepler guarda el
 * acumulado retirado (`c48`) y nada más.
 *
 * Con `retiro` como tipo válido, el conteo se puede capturar en el momento en que
 * el dinero sale, y al cerrar el turno cuadra la identidad completa:
 *
 *     Σ retiros contados + cajón contado = efectivo contado
 *
 * Aditiva e idempotente. No toca filas existentes: los `cierre` y `relevo` que ya
 * están siguen siendo válidos.
 */

exports.up = async function up(knex) {
  const existe = await knex.raw(`
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'reconciliation.blind_counts'::regclass
       AND conname = 'blind_counts_tipo_check'`);
  if (existe.rows.length) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT blind_counts_tipo_check`);
  }
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_tipo_check
      CHECK (tipo = ANY (ARRAY['cierre'::text, 'relevo'::text, 'retiro'::text]))`);

  // Un turno tiene UN cierre pero VARIOS retiros, así que el índice único que
  // ordena los cierres no puede aplicarles. Se indexa para la consulta que importa:
  // "cuánto lleva contado de retiros este turno".
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS blind_counts_retiros_por_turno_idx
      ON reconciliation.blind_counts (tenant_id, warehouse_code, cash_cut_folio)
      WHERE tipo = 'retiro'`);

  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.tipo IS
      'cierre = conteo del cajón al cerrar el turno · relevo = entrega entre cajeras · retiro = sangría durante el turno (donde va el 63-81% del efectivo)'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS reconciliation.blind_counts_retiros_por_turno_idx`);
  // El rollback falla a propósito si ya hay retiros capturados: tirarlos en
  // silencio sería borrar conteos de efectivo reales.
  const { rows } = await knex.raw(
    `SELECT count(*)::int n FROM reconciliation.blind_counts WHERE tipo = 'retiro'`);
  if (rows[0].n > 0) {
    throw new Error(`No se puede revertir: hay ${rows[0].n} arqueos de retiro capturados. Migrarlos o borrarlos a mano primero.`);
  }
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_tipo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_tipo_check
      CHECK (tipo = ANY (ARRAY['cierre'::text, 'relevo'::text]))`);
};
