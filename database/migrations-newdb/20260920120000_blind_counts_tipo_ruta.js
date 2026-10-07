/**
 * SM.36 — El arqueo de las rutas (RD y RV).
 *
 * Hasta hoy el arqueo ciego cubria la CAJA de mostrador: `cierre`, `relevo` y
 * `retiro`, todos atados a un turno de Kepler (`kdpv_folio_caja`). El vendedor de
 * ruta entrega su efectivo en la tienda y de eso no queda **nada** registrado.
 *
 * RD = ruta de reparto / venta a bordo · RV = ruta vecinal / preventa.
 *
 * ── Por que `route_code` y no meter la ruta en `caja`
 *
 * `caja` es NOT NULL y significa "la estacion de cobro". Una ruta no es una caja.
 * Meter ahi el codigo de ruta haria que la columna signifique dos cosas, que es
 * el defecto que este repo ya pago caro (`replenishment_plan.stock_pz`, cuyo
 * nombre miente; ADR-055). Para rd/rv `caja` lleva el literal 'RD'/'RV' —la
 * estacion, que es el modulo— y la ruta va en su propia columna.
 *
 * ── La clave unica tiene que incluir la ruta
 *
 * Medido: Padre Hidalgo (01) tiene **7 rutas RD** (21,22,23,26,27,28,29) y 2 RV.
 * Con la clave vieja —(tenant, sucursal, caja, fecha, cajero, tipo)— esa tienda
 * solo podria capturar UN arqueo RD por dia y el segundo pisaria al primero en
 * silencio. `route_code` entra a la clave.
 *
 * ⚠️ El `ON CONFLICT` de `BlindCountService.submit()` nombra esta clave columna
 * por columna. Si se toca el indice, se toca la sentencia: un target que no
 * resuelve no falla al compilar, falla al guardar (GOTCHAS §50).
 *
 * ── Lo que esta migracion NO habilita
 *
 * Una diferencia. El esperado de una caja sale de Kepler (`c15`); para una ruta
 * **no existe hoy**: medido contra `analytics.v_route_sales_lines`, las filas
 * vivas (`source='push'`) traen el vendedor vacio y `forma_pago_credito`/
 * `forma_pago_tarjeta` en NULL, asi que no se puede separar el efectivo de lo
 * que se fue a credito o tarjeta. El conteo se guarda como CUSTODIA —quien
 * entrego cuanto, con desglose por denominacion y sello— y la diferencia se
 * DECLARA no medible (ADR-056), nunca se dibuja en cero.
 *
 * Aditiva e idempotente. No toca ninguna fila existente.
 * @param { import("knex").Knex } knex
 */
const UQ_VIEJA = 'uq_blind_count';
const UQ_NUEVA = 'uq_blind_count_ruta';

const existeIndice = async (knex, name) => {
  const r = await knex.raw(
    `SELECT 1 FROM pg_indexes WHERE schemaname='reconciliation' AND tablename='blind_counts' AND indexname=?`,
    [name],
  );
  return r.rows.length > 0;
};

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;

  // 1. La columna de la ruta.
  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'route_code'))) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts ADD COLUMN route_code text`);
  }
  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.route_code IS
      'Solo tipo rd/rv: la route_key del catalogo (21, 501, RVPH01, VECINAL1...). NULL en cierre/relevo/retiro.'`);

  // 2. El CHECK gana los dos tipos nuevos.
  const ck = await knex.raw(`
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'reconciliation.blind_counts'::regclass
       AND conname = 'blind_counts_tipo_check'`);
  if (ck.rows.length) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT blind_counts_tipo_check`);
  }
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_tipo_check
      CHECK (tipo = ANY (ARRAY['cierre'::text, 'relevo'::text, 'retiro'::text, 'rd'::text, 'rv'::text]))`);

  /**
   * 3. Una ruta sin codigo no es un arqueo de ruta, y un arqueo de caja no puede
   *    traer ruta. Sin este CHECK, un `rd` con `route_code` nulo entraria y
   *    colisionaria con cualquier otro `rd` del mismo dia por el COALESCE.
   */
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_route_code_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_route_code_check
      CHECK ( (tipo IN ('rd','rv') AND route_code IS NOT NULL AND btrim(route_code) <> '')
           OR (tipo NOT IN ('rd','rv') AND route_code IS NULL) )`);

  // 4. La clave unica gana la ruta. Se crea la nueva ANTES de tirar la vieja: si
  //    algo la rechaza, la tabla se queda protegida por la que ya tenia.
  if (!(await existeIndice(knex, UQ_NUEVA))) {
    await knex.raw(`
      CREATE UNIQUE INDEX ${UQ_NUEVA}
        ON reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code, ''::text), tipo,
            COALESCE(route_code, ''::text))`);
  }
  if (await existeIndice(knex, UQ_VIEJA)) {
    await knex.raw(`DROP INDEX reconciliation.${UQ_VIEJA}`);
  }

  // 5. Indice de lectura: "que arqueos de ruta hay en esta tienda este dia".
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS blind_counts_rutas_idx
      ON reconciliation.blind_counts (tenant_id, warehouse_code, business_date, route_code)
      WHERE tipo IN ('rd','rv')`);

  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.tipo IS
      'cierre = cajon al cerrar el turno · relevo = entrega entre cajeras · retiro = sangria durante el turno · rd = entrega del vendedor de ruta de reparto · rv = entrega del vendedor de ruta vecinal'`);
};

exports.down = async function down(knex) {
  // El rollback falla a proposito si ya hay arqueos de ruta capturados: tirarlos
  // en silencio seria borrar conteos de efectivo reales.
  const { rows } = await knex.raw(
    `SELECT count(*)::int n FROM reconciliation.blind_counts WHERE tipo IN ('rd','rv')`);
  if (rows[0].n > 0) {
    throw new Error(
      `No se puede revertir: hay ${rows[0].n} arqueos de ruta capturados. Migrarlos o borrarlos a mano primero.`);
  }
  await knex.raw(`DROP INDEX IF EXISTS reconciliation.blind_counts_rutas_idx`);

  if (!(await existeIndice(knex, UQ_VIEJA))) {
    await knex.raw(`
      CREATE UNIQUE INDEX ${UQ_VIEJA}
        ON reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code, ''::text), tipo)`);
  }
  if (await existeIndice(knex, UQ_NUEVA)) {
    await knex.raw(`DROP INDEX reconciliation.${UQ_NUEVA}`);
  }

  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_route_code_check`);
  await knex.raw(`ALTER TABLE reconciliation.blind_counts DROP CONSTRAINT IF EXISTS blind_counts_tipo_check`);
  await knex.raw(`
    ALTER TABLE reconciliation.blind_counts
      ADD CONSTRAINT blind_counts_tipo_check
      CHECK (tipo = ANY (ARRAY['cierre'::text, 'relevo'::text, 'retiro'::text]))`);
  // `route_code` es aditiva: no se dropea.
};
