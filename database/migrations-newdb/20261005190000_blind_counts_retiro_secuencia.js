/**
 * El SEGUNDO retiro del día dejaba de existir.
 *
 * `uq_blind_count_ruta` es una clave única TOTAL:
 *
 *     (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''),
 *      tipo, COALESCE(route_code,''))
 *
 * `tipo` está adentro, pero nada excluye `'retiro'`. Y el `onConflict(...).merge()`
 * de `BlindCountService.submit()` pisa la fila: la sangría de las 15:22 reemplazaba
 * a la de las 11:04 —denominaciones, nota, incidencia y hora incluidas— con un
 * toast que decía «Arqueo guardado». Sin error, sin aviso.
 *
 * El comentario de `20260903170000_blind_counts_tipo_retiro.js` afirma lo
 * contrario: «Un turno tiene UN cierre pero VARIOS retiros, así que el índice
 * único que ordena los cierres no puede aplicarles». Sí les aplica.
 *
 * ── Lo que cuesta, medido en prod el 2026-10-05
 *
 * Una caja cierra UNA vez al día y hace tres o cuatro sangrías: el 94.8% de los
 * turnos que cruzan el límite tienen al menos una, y ahí va el 63-81% del
 * efectivo. Sobre los 25 cortes peores, `efectivo_retirado / retiro_contado` va
 * de 2.93 a 82 —varios clavados en enteros (3.00 dos veces, 5.07, 7.02)— y suman
 * **$1,086,606 de sangrías que Kepler registró y nosotros no tenemos contadas**.
 *
 * ⚠️ Eso NO prueba que se hayan pisado: la fila pisada ya no existe, así que la
 * tabla no distingue «se perdió» de «nunca se contó». Lo que sí es un hecho de
 * construcción es que, con la clave actual, **si alguna contó dos el mismo día la
 * segunda borró a la primera** — no había dónde guardarla.
 *
 * ── Por qué una columna y no un índice parcial
 *
 * Lo obvio sería `WHERE tipo <> 'retiro'` en la única. No se puede: Postgres exige
 * que la cláusula de inferencia del `ON CONFLICT` repita el predicado del índice
 * parcial, y `knex.onConflict()` no sabe emitirlo — habría que bajar el upsert a
 * SQL crudo y perder el `merge()` tipado.
 *
 * `secuencia` resuelve lo mismo sin tocar la forma del upsert: entra a la clave,
 * vale **1 para todo lo que hoy es único** (cierre, relevo, rd, rv) y se numera
 * 1,2,3… sólo en `retiro`. El comportamiento de los otros cuatro tipos no cambia
 * —incluida la prueba negativa de FASE SM.36, que exige que la misma ruta dos
 * veces el mismo día sea RECHAZADA— y la re-captura de una sangría concreta sigue
 * siendo un UPSERT sobre su propia fila.
 *
 * Aditiva e idempotente. No toca ninguna fila existente: el backfill las deja
 * todas en `secuencia = 1`, que es lo que ya eran.
 */

const UQ = 'uq_blind_count_ruta';
const UQ_NUEVA = 'uq_blind_count_secuencia';

const existeIndice = async (knex, name) => {
  const r = await knex.raw(
    `SELECT 1 FROM pg_indexes WHERE schemaname='reconciliation' AND tablename='blind_counts' AND indexname=?`,
    [name],
  );
  return r.rows.length > 0;
};

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;

  // 1. La columna. `NOT NULL DEFAULT 1` deja las filas viejas exactamente como estaban.
  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'secuencia'))) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts ADD COLUMN secuencia smallint NOT NULL DEFAULT 1`);
  }
  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.secuencia IS
      'Numero de la sangria dentro del turno (1,2,3...). SIEMPRE 1 en cierre/relevo/rd/rv: esos son unicos por definicion. Entra a la clave unica para que el segundo retiro del dia no pise al primero.'`);

  // 2. Nadie mas que `retiro` puede traer una secuencia distinta de 1. Sin este
  //    CHECK, un `cierre` con secuencia 2 entraria y habria DOS cierres del mismo
  //    turno — justo lo que la clave vieja si impedia bien.
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_secuencia_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_secuencia_check
      CHECK ( secuencia >= 1 AND (tipo = 'retiro' OR secuencia = 1) )`);

  // 3. La clave unica gana la secuencia. Se crea la nueva ANTES de tirar la vieja:
  //    si algo la rechaza, la tabla se queda protegida por la que ya tenia.
  if (!(await existeIndice(knex, UQ_NUEVA))) {
    await knex.raw(`
      CREATE UNIQUE INDEX ${UQ_NUEVA}
        ON reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code, ''::text), tipo,
            COALESCE(route_code, ''::text), secuencia)`);
  }
  if (await existeIndice(knex, UQ)) {
    await knex.raw(`DROP INDEX reconciliation.${UQ}`);
  }
};

exports.down = async function down(knex) {
  // El rollback falla a proposito si ya hay mas de una sangria por turno: volver a
  // la clave vieja las COLAPSARIA, que es borrar conteos de efectivo reales.
  const { rows } = await knex.raw(`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM reconciliation.blind_counts
       WHERE tipo = 'retiro'
       GROUP BY tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''), COALESCE(route_code,'')
      HAVING count(*) > 1
    ) d`);
  if (rows[0].n > 0) {
    throw new Error(
      `No se puede revertir: hay ${rows[0].n} turno(s) con mas de una sangria contada. ` +
      'La clave vieja solo admite una y las demas se perderian. Migrarlas o archivarlas primero.');
  }

  if (!(await existeIndice(knex, UQ))) {
    await knex.raw(`
      CREATE UNIQUE INDEX ${UQ}
        ON reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code, ''::text), tipo,
            COALESCE(route_code, ''::text))`);
  }
  if (await existeIndice(knex, UQ_NUEVA)) {
    await knex.raw(`DROP INDEX reconciliation.${UQ_NUEVA}`);
  }
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_secuencia_check`);
  if (await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'secuencia')) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP COLUMN secuencia`);
  }
};
