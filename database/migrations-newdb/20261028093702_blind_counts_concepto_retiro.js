/**
 * [SM.49] El concepto del retiro: por qué salió ese dinero de la caja.
 *
 * Pedido de la operación (2026-10-28, maqueta aprobada): al capturar un retiro, la
 * cajera elige el concepto en el mismo menú del tipo de arqueo:
 *
 *   retiro_caja     Retiro de caja (la sangría que pide Kepler por el límite)
 *   pago_proveedor  Pago a proveedor
 *   pago_nomina     Pago de nómina
 *   gasto_sucursal  Gasto de la sucursal (caja chica)
 *   deposito_banco  Depósito al banco
 *   otro            Otro — y entonces el MOTIVO escrito es obligatorio
 *
 * ── Lo que cambia
 *
 *  1. Columna `concepto` (text, nullable). Solo `retiro` la puede traer y solo con un
 *     valor de la lista. Los retiros VIEJOS quedan en NULL («sin concepto»): no se
 *     inventa uno para el pasado.
 *  2. `blind_counts_motivo_check` (SM.47) se amplía: el motivo, que hasta hoy era solo
 *     del conteo sin caja, también es OBLIGATORIO en un retiro con concepto `otro`.
 *
 * Todos los retiros, con cualquier concepto, siguen siendo `tipo = 'retiro'`: se ligan
 * a su turno y suman al cuadre contra Kepler igual que hoy (decisión del pedido). RD y
 * RV siguen aparte.
 *
 * Aditiva e idempotente. Ninguna fila existente cambia: todas quedan con concepto NULL,
 * que es lo que el CHECK nuevo admite para ellas.
 */

const CONCEPTOS = ['retiro_caja', 'pago_proveedor', 'pago_nomina', 'gasto_sucursal', 'deposito_banco', 'otro'];
const lista = CONCEPTOS.map((c) => `'${c}'`).join(', ');

const MOTIVO_OK = `(motivo IS NOT NULL AND btrim(motivo) <> '' AND char_length(motivo) <= 200)`;

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;

  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'concepto'))) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts ADD COLUMN concepto text`);
  }
  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.concepto IS
      'Solo tipo retiro: por que salio el dinero (${CONCEPTOS.join(' | ')}). NULL en los retiros anteriores a SM.49 y en los demas tipos. Con otro, el motivo es obligatorio.'`);

  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_concepto_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_concepto_check
      CHECK ( concepto IS NULL OR (tipo = 'retiro' AND concepto IN (${lista})) )`);

  // El motivo: obligatorio en el conteo sin caja (SM.47) y en el retiro «otro»; nulo en lo demás.
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_motivo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_motivo_check
      CHECK (
           (tipo = 'sin_caja' AND ${MOTIVO_OK})
        OR (tipo = 'retiro' AND concepto = 'otro' AND ${MOTIVO_OK})
        OR (motivo IS NULL AND tipo <> 'sin_caja' AND NOT (tipo = 'retiro' AND concepto IS NOT DISTINCT FROM 'otro'))
      )`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;
  // Se niega si ya hay retiros con concepto: bajar la columna borra por qué salió ese dinero.
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM reconciliation.blind_counts WHERE concepto IS NOT NULL`);
  if (rows[0].n > 0) {
    throw new Error(`No se puede revertir: hay ${rows[0].n} retiro(s) con concepto. Archivarlos primero.`);
  }
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_motivo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_motivo_check
      CHECK ( (tipo = 'sin_caja' AND ${MOTIVO_OK})
           OR (tipo <> 'sin_caja' AND motivo IS NULL) )`);
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_concepto_check`);
  if (await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'concepto')) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP COLUMN concepto`);
  }
};
