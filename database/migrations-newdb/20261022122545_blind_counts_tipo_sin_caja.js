/**
 * [SM.47] «Conteo de efectivo»: un arqueo que NO va ligado a una caja.
 *
 * Pedido de la operacion: la encargada de sucursal, Finanzas y el jefe de zona
 * necesitan contar efectivo que no es el cajon de una cajera (caja fuerte, fondo
 * de cambio, un conteo de supervision...). Hoy la tabla exige `caja` y los cinco
 * tipos que acepta cuelgan de una caja o de una ruta.
 *
 * ── Por que un tipo nuevo y no `caja` nullable
 *
 * `caja` entra a la clave unica `uq_blind_count_secuencia`. Con NULL la clave deja
 * de deduplicar (NULL <> NULL) y ademas habria que tocar cada JOIN por caja
 * (turnos pendientes, por cajera, SLA, conciliacion de movimientos). Se sigue el
 * precedente de RD/RV: el servicio guarda el literal `SIN_CAJA` en `caja` y el
 * tipo `sin_caja` dice que no hay turno ni esperado.
 *
 * ── Lo que cambia
 *
 *  1. `blind_counts_tipo_check` acepta `sin_caja`.
 *  2. `blind_counts_secuencia_check`: `sin_caja` se numera como `retiro` — puede
 *     haber varios conteos el mismo dia en la misma sucursal y el segundo NO debe
 *     pisar al primero (la leccion de 20261005190000).
 *  3. Columna `motivo` (text, nullable). Sin caja ni esperado, el motivo es lo
 *     UNICO que explica por que se conto ese dinero: en `sin_caja` es obligatorio
 *     (1 a 200 caracteres); en los demas tipos queda nulo.
 *
 * Aditiva e idempotente. No toca ninguna fila existente: ninguna es `sin_caja` y
 * todas quedan con `motivo` nulo, que es lo que el CHECK pide para ellas.
 */

const TIPOS_NUEVOS = ['cierre', 'relevo', 'retiro', 'rd', 'rv', 'sin_caja'];
const TIPOS_VIEJOS = ['cierre', 'relevo', 'retiro', 'rd', 'rv'];

const arr = (xs) => `ARRAY[${xs.map((t) => `'${t}'::text`).join(', ')}]`;

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;

  // 1. El tipo nuevo.
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_tipo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_tipo_check
      CHECK (tipo = ANY (${arr(TIPOS_NUEVOS)}))`);

  // 2. `sin_caja` se numera (varios por dia); los demas siguen en 1 salvo `retiro`.
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_secuencia_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_secuencia_check
      CHECK ( secuencia >= 1 AND (tipo IN ('retiro','sin_caja') OR secuencia = 1) )`);

  // 3. El motivo.
  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'motivo'))) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts ADD COLUMN motivo text`);
  }
  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.motivo IS
      'Solo tipo sin_caja (Conteo de efectivo): por que se conto ese dinero. Obligatorio ahi (1-200), nulo en los demas tipos.'`);
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_motivo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_motivo_check
      CHECK ( (tipo = 'sin_caja' AND motivo IS NOT NULL AND btrim(motivo) <> '' AND char_length(motivo) <= 200)
           OR (tipo <> 'sin_caja' AND motivo IS NULL) )`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;
  // Se niega si ya hay conteos sin caja: revertir el CHECK los dejaria invalidos, y
  // borrarlos es borrar conteos de efectivo reales.
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM reconciliation.blind_counts WHERE tipo = 'sin_caja'`);
  if (rows[0].n > 0) {
    throw new Error(
      `No se puede revertir: hay ${rows[0].n} conteo(s) de efectivo sin caja. ` +
      'El CHECK viejo no los admite. Archivarlos primero.');
  }
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_motivo_check`);
  if (await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'motivo')) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP COLUMN motivo`);
  }
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_secuencia_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_secuencia_check
      CHECK ( secuencia >= 1 AND (tipo = 'retiro' OR secuencia = 1) )`);
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_tipo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_tipo_check
      CHECK (tipo = ANY (${arr(TIPOS_VIEJOS)}))`);
};
