'use strict';
/**
 * `[RD.52]` — **El contraste: lo que el libro pagó contra lo que el motor pagaría.**
 *
 * ── Lo medido antes, contra prod el 2026-10-08 (238 ruta-periodo del espejo) ────────────────
 *
 *   cuadra (<= $1)                 111    551,006.43  vs  551,006.22
 *   difiere <= 5%                   46    230,925.98  vs  231,031.08   (+105: el motor paga MAS)
 *   difiere > 5%                    22    120,555.20  vs   79,291.15
 *   el libro pago y el motor NO      9     26,932.74  vs        0.00   <- acantilado del tramo
 *   sin fuente en el motor           5      8,361.52  vs        0.00
 *   ninguno paga (coinciden)        45
 *                                  238    937,781.87  vs  861,328.45     delta -76,453.42
 *
 * **111 de las 193 que pagan cuadran al peso (57.5%)**, y el dano esta concentrado en **14
 * filas que el motor tira a CERO** ($35,294): 9 por el acantilado del tramo mas bajo
 * ($189,999.99 de venta) y 5 sin fuente. Si el motor hubiera pagado 2026, los choferes
 * cobraban **8.2% menos**.
 *
 * ── Por que una tabla propia, y por que SOLO el lado del motor ──────────────────────────────
 *
 * ⛔ **No puede vivir en `commission_runs`.** El indice `commission_runs_una_viva_por_periodo`
 * es UNIQUE sobre `(tenant_id, period_id)` filtrado a lo no borrado y no anulado: con el espejo
 * ocupando el lugar en estado `pagado`, una segunda corrida del motor no entra. Y meterla
 * igual seria contaminar el libro mayor de la nomina con una simulacion.
 *
 * ⭐ **Solo se guarda el lado del MOTOR.** El del libro ya esta en `commission_run_lines` y es
 * el mismo dato: duplicarlo congelaria una foto que puede quedar vieja -- el espejo se
 * recargo dos veces el mismo dia que nacio. La vista hace el cruce, asi que el veredicto
 * siempre refleja el libro VIGENTE, no el que habia cuando se corrio el contraste.
 *
 * ⚠️ **Las filas las escribe el MOTOR REAL** (`computeRun` en modo vista previa), no una copia
 * de su regla en SQL. La medicion de arriba si uso SQL reimplementado, y sirvio para
 * dimensionar; para la pantalla no alcanza, porque una copia se desincroniza y el tablero se
 * queda verde midiendo una regla que ya nadie corre.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TBL = 'commercial.commission_engine_lines';
const VIEW = 'analytics.v_rd_commission_contrast';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const existe = await knex.schema.withSchema('commercial').hasTable('commission_engine_lines');
  if (!existe) {
    await knex.schema.withSchema('commercial').createTable('commission_engine_lines', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('period_id').notNullable();
      t.uuid('scale_id').notNullable();
      t.string('route_code', 24).notNullable();
      t.string('beneficiario', 16).notNullable();

      t.decimal('subtotal', 16, 2);
      t.decimal('venta', 16, 2);
      t.decimal('costo', 16, 2);
      t.decimal('markup_sobre_costo_pct', 10, 4);
      t.decimal('pct_aplicado', 8, 4);
      t.decimal('comision', 14, 2).notNullable().defaultTo(0);
      t.decimal('bonos', 14, 2).notNullable().defaultTo(0);
      t.jsonb('bonos_detalle').notNullable().defaultTo('[]');
      t.decimal('nomina_banco', 14, 2).notNullable().defaultTo(0);
      t.decimal('a_pagar', 14, 2).notNullable().defaultTo(0);
      t.string('motivo_no_pago', 40);

      /** `[RD.23]` la cobertura de dias, que es lo que explica 14 de las 17 que difieren. */
      t.integer('dias_con_venta');
      t.integer('dias_esperados');
      t.string('costo_veredicto', 32);
      t.string('fuentes', 48);

      /** Cuando corrio el motor. Sin esto, un contraste viejo se lee como recien medido. */
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.foreign('period_id').references('id').inTable('commercial.commission_periods').onDelete('CASCADE');
      t.unique(['tenant_id', 'period_id', 'route_code', 'beneficiario'],
        { indexName: 'commission_engine_lines_natural_unique' });
      t.check("beneficiario IN ('chofer','supervisor')", [], 'commission_engine_lines_benef_valid');
      t.index(['tenant_id', 'period_id'], 'idx_commission_engine_lines_period');
    });
  }

  await knex.raw(`COMMENT ON TABLE ${TBL} IS
    'RD.52 - la corrida del MOTOR para contrastarla contra el espejo del libro. NO es nomina: es una simulacion. Vive aparte de commission_runs porque el indice una_viva_por_periodo prohibe una segunda corrida viva y porque mezclar una simulacion con el libro mayor de la nomina es como se publican cifras que nadie pidio. La escribe computeRun() en modo vista previa, no una copia de su regla.'`);

  // ── RLS forzado, como el resto de `commercial.*` ───────────────────────────────────────────
  await knex.raw(`ALTER TABLE ${TBL} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TBL} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${TBL}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${TBL}
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TBL} TO app_runtime`);

  // ── La vista del contraste ─────────────────────────────────────────────────────────────────
  // ⭐ El veredicto vive ACA y en un solo lugar. Cinco estados, no dos: "el libro pago y el
  // motor da cero" no es "difiere mucho" -- es el acantilado del tramo, se arregla distinto, y
  // promediarlo con el resto lo esconde. Y lo que no se puede comparar se DECLARA
  // (`sin_corrida_del_motor`), nunca se lee como que cuadra.
  // ⚠️ La union de claves va PRIMERO. La version anterior hacia `p LEFT JOIN lib FULL OUTER
  // JOIN mot`: una fila que solo existe del lado del motor quedaba sin periodo, y el
  // `WHERE p.deleted_at IS NULL` la descartaba -- justo el caso `solo_el_motor` que la vista
  // dice declarar. Un outer join contra el resultado de otro join no conserva lo que promete.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW} AS
    WITH lib AS (
      SELECT r.period_id, l.*
        FROM commercial.commission_run_lines l
        JOIN commercial.commission_runs r
          ON r.id = l.run_id AND r.deleted_at IS NULL AND r.status <> 'anulado'
       WHERE l.deleted_at IS NULL AND l.beneficiario = 'chofer'
    ), mot AS (
      SELECT * FROM ${TBL} WHERE beneficiario = 'chofer'
    ), claves AS (
      SELECT tenant_id, period_id, route_code FROM lib
      UNION
      SELECT tenant_id, period_id, route_code FROM mot
    )
    SELECT
      k.tenant_id,
      p.id                       AS period_id,
      p.anio,
      p.period_no,
      to_char(p.date_from, 'YYYY-MM-DD') AS date_from,
      to_char(p.date_to,   'YYYY-MM-DD') AS date_to,
      k.route_code,
      lib.beneficiario_nombre,
      lib.zona,

      lib.venta        AS libro_venta,
      lib.subtotal     AS libro_subtotal,
      lib.pct_aplicado AS libro_pct,
      lib.comision     AS libro_comision,
      lib.bonos        AS libro_bonos,
      lib.nomina_banco AS libro_nomina,
      lib.a_pagar      AS libro_a_pagar,
      lib.motivo_no_pago AS libro_motivo,

      mot.venta        AS motor_venta,
      mot.subtotal     AS motor_subtotal,
      mot.pct_aplicado AS motor_pct,
      mot.comision     AS motor_comision,
      mot.bonos        AS motor_bonos,
      mot.a_pagar      AS motor_a_pagar,
      mot.motivo_no_pago AS motor_motivo,
      mot.dias_con_venta,
      mot.dias_esperados,
      mot.costo_veredicto,
      mot.computed_at,

      CASE WHEN lib.a_pagar IS NULL OR mot.a_pagar IS NULL THEN NULL
           ELSE round(mot.a_pagar - lib.a_pagar, 2) END AS delta_a_pagar,

      CASE
        WHEN mot.route_code IS NULL                          THEN 'sin_corrida_del_motor'
        WHEN lib.route_code IS NULL                          THEN 'solo_el_motor'
        WHEN lib.motivo_no_pago IS NOT NULL
         AND mot.motivo_no_pago IS NOT NULL                  THEN 'ninguno_paga'
        WHEN lib.motivo_no_pago IS NOT NULL                  THEN 'solo_el_motor_paga'
        WHEN mot.motivo_no_pago IS NOT NULL                  THEN 'el_motor_no_paga'
        WHEN abs(mot.a_pagar - lib.a_pagar) <= 1.00          THEN 'cuadra'
        WHEN abs(mot.a_pagar - lib.a_pagar)
             <= abs(NULLIF(lib.a_pagar, 0)) * 0.05           THEN 'difiere_poco'
        ELSE                                                      'difiere'
      END AS veredicto,

      -- ⚠️ La causa NO se adivina: la cobertura de dias explica 14 de las 17 que difieren
      -- (RD.23), y el resto queda 'sin_explicar' en vez de atribuirse a lo mas a mano.
      CASE
        WHEN mot.route_code IS NULL                          THEN NULL
        WHEN mot.dias_con_venta IS NULL
          OR mot.dias_esperados IS NULL                      THEN 'cobertura_no_medida'
        WHEN mot.dias_con_venta < mot.dias_esperados         THEN 'faltan_dias_en_la_fuente'
        ELSE                                                      'sin_explicar'
      END AS causa

    FROM claves k
    JOIN commercial.commission_periods p
      ON p.id = k.period_id AND p.tenant_id = k.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN lib ON lib.tenant_id = k.tenant_id AND lib.period_id = k.period_id
                 AND lib.route_code = k.route_code
    LEFT JOIN mot ON mot.tenant_id = k.tenant_id AND mot.period_id = k.period_id
                 AND mot.route_code = k.route_code`);

  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    'RD.52 - el libro (commission_run_lines de la corrida viva) contra el motor (commission_engine_lines), con veredicto y causa. El veredicto vive SOLO aca. Cinco estados y no dos: "el motor no paga" es el acantilado del tramo y se arregla distinto que "difiere"; promediarlos lo esconde. Lo que no se puede comparar se declara sin_corrida_del_motor, nunca se lee como que cuadra.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  const existe = await knex.schema.withSchema('commercial').hasTable('commission_engine_lines');
  if (existe) await knex.schema.withSchema('commercial').dropTable('commission_engine_lines');
};
