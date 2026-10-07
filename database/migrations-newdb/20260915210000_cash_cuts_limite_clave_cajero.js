/**
 * SM.35 — El límite de caja entra al corte, y el turno deja de perderse.
 *
 * Dos cosas, ambas medidas en prod antes de escribirse:
 *
 * 1. `cash_limit` (Kepler `c46`) y `cash_limit_max` (`c47`). Son PARÁMETROS, no
 *    mediciones: 46 valores distintos en 3,844 cortes, todos redondos, y estables
 *    por caja (el valor modal concentra el 70.6% de los turnos de cada caja-mes).
 *    `c46` es el umbral que dispara la sangría — verificado con la curva: si el
 *    esperado no llega al límite hay retiro en 2.4-14.1% de los turnos, y al
 *    cruzarlo salta a 70.8% → 99.1% → 99.9%. Es una función escalón centrada en
 *    `c46`, no una correlación. `c47` queda como segundo escalón (el cajón final
 *    rebasa `c46` en 11.7% de los turnos pero `c47` en solo 1.77%) y se guarda
 *    SIN afirmar qué hace: no está en el decode y no se contrastó contra la UI.
 *    NO son $15,000 para todos: suc01 caja4 corre en $70,000 y suc04 caja2 en
 *    $8,000. El código traía "típicamente 15000" escrito como si fuera constante.
 *
 * 2. La clave única gana `cajero_cierre`. En el ODS el folio (`c3`) se REUSA
 *    dentro del mismo día y la misma caja: 15 claves duplicadas, las 15 con
 *    dinero distinto. Caso verificado — suc01 caja1 03/09 folio 68 son dos
 *    turnos de dos cajeros: `10C01` con esperado $53,474.85 / retiro $49,000 y
 *    `26VHGH` con $12,184.01 / retiro $0. El `DISTINCT ON` del sync se queda con
 *    uno y el otro NO EXISTE en esta tabla: 16 filas, $485,076.32 de esperado y
 *    $278,900 de retiro que nunca llegaron.
 *
 * `NULLS NOT DISTINCT` (PG15+) y no `COALESCE(...,'')`: en un índice único los
 * NULL son distintos por default, así que sin esto dos cortes sin cajero del
 * mismo folio volverían a coexistir — justo el agujero que se está cerrando.
 *
 * Aditiva + idempotente. `analytics.*` sin RLS.
 * @param { import("knex").Knex } knex
 */
const UQ_VIEJA = 'uq_cash_cut';
const UQ_NUEVA = 'uq_cash_cut_cajero';

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('cash_cuts'))) return;

  // `COMMENT ON` no acepta bind params (`$1` es error de sintaxis ahí), así que
  // el texto va inline con la comilla escapada a mano.
  const add = async (col, type, comment) => {
    if (!(await knex.schema.withSchema('analytics').hasColumn('cash_cuts', col))) {
      await knex.raw(`ALTER TABLE analytics.cash_cuts ADD COLUMN ${col} ${type}`);
    }
    await knex.raw(`COMMENT ON COLUMN analytics.cash_cuts.${col} IS '${String(comment).replace(/'/g, "''")}'`);
  };
  await add('cash_limit', 'numeric',
    'Kepler c46 — límite de efectivo en el cajón que dispara la sangría. Parámetro por caja, NO constante.');
  await add('cash_limit_max', 'numeric',
    'Kepler c47 — segundo escalón por encima de c46. Semántica NO verificada: se guarda, no se interpreta.');

  // El índice nuevo se crea ANTES de tirar el viejo: si algo lo rechaza, la
  // tabla se queda protegida por el que ya tenía en vez de quedar sin ninguno.
  const existe = async (name) => {
    const r = await knex.raw(
      `SELECT 1 FROM pg_indexes WHERE schemaname='analytics' AND tablename='cash_cuts' AND indexname=?`, [name]);
    return r.rows.length > 0;
  };

  if (!(await existe(UQ_NUEVA))) {
    // Freno explícito: si ya hay filas que violarían la clave nueva, la migración
    // para y lo DICE, en vez de reventar con un error de índice sin contexto.
    const dup = await knex.raw(`
      SELECT tenant_id, warehouse_code, caja, business_date, folio, count(*) n
        FROM analytics.cash_cuts
       GROUP BY 1,2,3,4,5, COALESCE(cajero_cierre,'')
        HAVING count(*) > 1 LIMIT 5`);
    if (dup.rows.length) {
      throw new Error(
        `[SM.35] analytics.cash_cuts ya tiene ${dup.rows.length}+ filas que colisionan en la clave nueva. ` +
        `Resolver antes de migrar: ${JSON.stringify(dup.rows[0])}`);
    }
    await knex.raw(`
      CREATE UNIQUE INDEX ${UQ_NUEVA}
        ON analytics.cash_cuts (tenant_id, warehouse_code, caja, business_date, folio, cajero_cierre)
        NULLS NOT DISTINCT`);
  }
  if (await existe(UQ_VIEJA)) await knex.raw(`DROP INDEX analytics.${UQ_VIEJA}`);
};

exports.down = async function (knex) {
  // Solo se revierte el índice (las columnas son aditivas). Se repone el viejo
  // antes de tirar el nuevo, por el mismo motivo que en el `up`.
  const existe = async (name) => {
    const r = await knex.raw(
      `SELECT 1 FROM pg_indexes WHERE schemaname='analytics' AND tablename='cash_cuts' AND indexname=?`, [name]);
    return r.rows.length > 0;
  };
  if (!(await existe(UQ_VIEJA))) {
    await knex.raw(`
      CREATE UNIQUE INDEX ${UQ_VIEJA}
        ON analytics.cash_cuts (tenant_id, warehouse_code, caja, business_date, folio)`);
  }
  if (await existe(UQ_NUEVA)) await knex.raw(`DROP INDEX analytics.${UQ_NUEVA}`);
};
