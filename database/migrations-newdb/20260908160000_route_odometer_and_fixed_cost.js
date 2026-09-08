/**
 * RD.5 — El odómetro de la ruta, el costo fijo por ruta, y el $/km que el Excel calcula mal.
 *
 * ── QUÉ REEMPLAZA ───────────────────────────────────────────────────────────────────────
 * La hoja `OPERACION DE LAS RUTAS` (KM INICIAL / KM FINAL capturados a mano) y las fichas
 * `COSTO RD PH` / `COSTO RD CANINDO` (costo fijo anual por vehículo).
 *
 * ── LO QUE ESTÁ ROTO EN EL EXCEL ────────────────────────────────────────────────────────
 * `OPERACION!K5` (COSTO FIJO X KM) hace
 * `SUMIF(E5,"21",$B$8)+SUMIF(E5,"22",$B$11)+…` y `$B$8`/`$B$11` son celdas de la **columna
 * PERIODO de su propia hoja** (valen 1, 2, 3). Resultado verificado: **$/km = 1** para todas
 * las rutas, cuando debería ser 6.12–9.13. De ahí cuelgan `COSTO POR KM` y
 * `% DE RENTABILIDAD`, o sea la mitad del tablero.
 *
 * Y las fichas de costo **no alimentan nada**: su columna `O` ($/km) —justo lo que
 * `OPERACION` necesita— no se referencia desde ninguna parte del libro. Sólo entran dos
 * celdas de texto por bloque (la unidad y el chofer).
 *
 * ── EL ODÓMETRO TIENE ERRORES DE CAPTURA, Y NO SE CORRIGEN ──────────────────────────────
 * Medido sobre las 187 lecturas periodo×ruta del workbook:
 *   · **160 de 175 (91.4%)** caen en una banda creíble. Mediana **1,050 km/quincena**,
 *     p95 1,738; los promedios por ruta van de 743 a 1,583 km/quincena, muy consistentes.
 *   · 15 quedan fuera, y vienen **en pares que se cancelan**: p7 r503 −181,921 seguido de
 *     p8 r503 +181,921 (`ki=205095 → kf=23174`, o sea `223174` con el 2 comido). Lo mismo
 *     en r23, r501, r504.
 *
 * Es un dígito mal tecleado. Se **detecta** y se rotula (`km_status`), pero NO se corrige:
 * poner el 2 que falta sería inventar la lectura. El `$/km` sale sólo donde el odómetro es
 * coherente, y la cobertura se declara.
 *
 * La banda (`0 < km <= 5000`) salió de MEDIR, no de elegir: es ~3× el p95, así que sólo
 * rechaza los saltos obvios y no toca ninguna quincena real.
 *
 * @param { import("knex").Knex } knex
 */

// De las fichas COSTO RD PH / CANINDO: [ruta, TOTAL GASTO anual, KM base anual].
// El $/km se DERIVA (total/km), no se copia: el Excel lo tiene calculado en su columna O y
// nadie lo consume, así que no hay una segunda cifra que pueda desincronizarse.
const FICHAS = [
  ['21', 163770.72, 24000], ['22', 157438.23, 21000], ['23', 165262.22, 27000],
  ['26', 163770.72, 21500], ['27', 163770.72, 21500],
  ['501', 273801.65, 30000], ['502', 273802.28, 30000], ['503', 272500.72, 30000],
  ['504', 216198.94, 30000], ['505', 216198.94, 30000],
];

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('logistics').hasTable('route_odometer')) return;

  await knex.schema.withSchema('logistics').createTable('route_odometer', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('route_code', 24).notNullable();
    t.integer('anio').notNullable();
    t.integer('period_no').notNullable();
    t.integer('km_inicial').nullable();
    t.integer('km_final').nullable();
    t.string('unidad', 80).nullable();     // el rótulo del vehículo en la ficha
    t.uuid('vehicle_id').nullable();
    t.string('source', 24).notNullable().defaultTo('captura_web'); // excel_import | captura_web
    t.text('notes').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by').nullable();
    t.uuid('updated_by').nullable();
    t.timestamp('deleted_at').nullable();
    t.uuid('deleted_by').nullable();

    t.primary('id');
    t.check('km_inicial IS NULL OR km_inicial >= 0', [], 'route_odometer_ki_nonneg');
    t.check('km_final IS NULL OR km_final >= 0', [], 'route_odometer_kf_nonneg');
    t.check(`?? in ('excel_import','captura_web')`, ['source'], 'route_odometer_source_valid');
    t.index(['tenant_id', 'route_code', 'anio', 'period_no'], 'idx_route_odometer_ruta_periodo');
  });

  await knex.raw(`
    ALTER TABLE logistics.route_odometer
      ADD CONSTRAINT fk_route_odometer_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  await knex.raw(`
    CREATE UNIQUE INDEX route_odometer_natural_unique
      ON logistics.route_odometer (tenant_id, route_code, anio, period_no)
      WHERE deleted_at IS NULL`);
  // ⚠️ NO hay CHECK `km_final >= km_inicial`: el dato real lo viola 10 veces y rechazarlo
  // haría perder la lectura. Se guarda tal cual y el veredicto lo pone `km_status` en la
  // vista — declarar, no descartar.

  await knex.raw(`ALTER TABLE logistics.route_odometer ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE logistics.route_odometer FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON logistics.route_odometer`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON logistics.route_odometer
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.route_odometer TO app_runtime`);

  // ── Costo fijo por ruta → logistics.config_finance ───────────────────────────────────
  const { rows: tenants } = await knex.raw(`SELECT id FROM identity.tenants`);
  for (const { id } of tenants) {
    const filas = [];
    for (const [ruta, anual, kmBase] of FICHAS) {
      filas.push({
        tenant_id: id, key: `RD.${ruta}.costo_fijo_anual`, category: 'costo_km',
        description: `Ruta ${ruta} — TOTAL GASTO anual de su ficha (GF+GV+GA)`,
        value: anual, unit: 'MXN/anio', active: true,
      });
      filas.push({
        tenant_id: id, key: `RD.${ruta}.km_base_anual`, category: 'costo_km',
        description: `Ruta ${ruta} — KILOMETRAJE base anual de su ficha (divisor del $/km)`,
        value: kmBase, unit: 'km/anio', active: true,
      });
    }
    await knex('logistics.config_finance').insert(filas).onConflict(['tenant_id', 'key']).ignore();
  }

  // ── La vista: la hoja OPERACION DE LAS RUTAS, calculada bien ──────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_operation_period WITH (security_invoker = true) AS
    WITH ficha AS (
      SELECT tenant_id,
             split_part(key, '.', 2)                                   AS route_code,
             max(value) FILTER (WHERE key LIKE '%.costo_fijo_anual')   AS costo_fijo_anual,
             max(value) FILTER (WHERE key LIKE '%.km_base_anual')      AS km_base_anual
      FROM logistics.config_finance
      WHERE category = 'costo_km' AND key LIKE 'RD.%' AND active
      GROUP BY 1, 2
    ), odo AS (
      SELECT o.tenant_id, o.route_code, o.anio, o.period_no, o.km_inicial, o.km_final,
             CASE
               WHEN o.km_inicial IS NULL OR o.km_final IS NULL     THEN 'incompleto'
               WHEN o.km_final < o.km_inicial                      THEN 'retroceso'
               WHEN o.km_final - o.km_inicial > 5000               THEN 'salto_implausible'
               WHEN o.km_final = o.km_inicial                      THEN 'sin_movimiento'
               ELSE 'ok'
             END                                                   AS km_status,
             CASE
               WHEN o.km_inicial IS NOT NULL AND o.km_final IS NOT NULL
                AND o.km_final > o.km_inicial AND o.km_final - o.km_inicial <= 5000
               THEN o.km_final - o.km_inicial
             END                                                   AS km_recorridos
      FROM logistics.route_odometer o
      WHERE o.deleted_at IS NULL
    ), gasto AS (
      SELECT e.tenant_id, e.route_code, p.anio, p.period_no,
             round(sum(e.total)::numeric, 2)                                  AS gasto_total,
             round(sum(e.total) FILTER (WHERE e.expense_type = 4)::numeric, 2) AS gasto_combustible,
             round(sum(e.liters)::numeric, 3)                                 AS litros,
             count(*)::int                                                    AS docs
      FROM logistics.route_expenses e
      JOIN commercial.commission_periods p
        ON p.tenant_id = e.tenant_id AND e.expense_date BETWEEN p.date_from AND p.date_to
      WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL
      GROUP BY 1, 2, 3, 4
    )
    SELECT
      COALESCE(o.tenant_id, g.tenant_id)      AS tenant_id,
      COALESCE(o.route_code, g.route_code)    AS route_code,
      COALESCE(o.anio, g.anio)                AS anio,
      COALESCE(o.period_no, g.period_no)      AS period_no,
      o.km_inicial, o.km_final,
      o.km_recorridos,
      COALESCE(o.km_status, 'sin_lectura')    AS km_status,
      g.litros, g.gasto_combustible, g.gasto_total, g.docs,
      -- $/litro: sale del gasto real, no de un parámetro.
      CASE WHEN g.litros > 0
           THEN round((g.gasto_combustible / g.litros)::numeric, 4) END       AS costo_por_litro,
      -- Rendimiento: sólo si el odómetro es coherente. Sin eso, NULL, no cero.
      CASE WHEN o.km_recorridos IS NOT NULL AND g.litros > 0
           THEN round((o.km_recorridos / g.litros)::numeric, 3) END           AS km_por_litro,
      -- $/km del costo FIJO, derivado de la ficha. Éste es el que el Excel deja en 1.
      CASE WHEN f.km_base_anual > 0
           THEN round((f.costo_fijo_anual / f.km_base_anual)::numeric, 4) END AS costo_fijo_por_km,
      f.costo_fijo_anual, f.km_base_anual,
      -- Costo total del periodo: la parte fija prorrateada por km recorrido + el gasto real.
      CASE WHEN o.km_recorridos IS NOT NULL AND f.km_base_anual > 0
           THEN round((o.km_recorridos * (f.costo_fijo_anual / f.km_base_anual) + COALESCE(g.gasto_total, 0))::numeric, 2)
      END                                                                     AS costo_operacion,
      CASE WHEN o.km_recorridos IS NOT NULL AND f.km_base_anual > 0
           THEN round(((o.km_recorridos * (f.costo_fijo_anual / f.km_base_anual) + COALESCE(g.gasto_total, 0)) / o.km_recorridos)::numeric, 4)
      END                                                                     AS costo_por_km,
      -- Por qué falta lo que falta, en la misma fila.
      CASE
        WHEN o.km_recorridos IS NULL AND f.km_base_anual IS NULL THEN 'sin_odometro_ni_ficha'
        WHEN o.km_recorridos IS NULL                             THEN 'odometro_' || COALESCE(o.km_status, 'sin_lectura')
        WHEN f.km_base_anual IS NULL                             THEN 'sin_ficha_de_costo'
        ELSE 'ok'
      END                                                                     AS costo_status
    FROM odo o
    FULL JOIN gasto g
      ON g.tenant_id = o.tenant_id AND g.route_code = o.route_code
     AND g.anio = o.anio AND g.period_no = o.period_no
    LEFT JOIN ficha f
      ON f.tenant_id = COALESCE(o.tenant_id, g.tenant_id)
     AND f.route_code = COALESCE(o.route_code, g.route_code)
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_route_operation_period TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE logistics.route_odometer IS 'RD.5 — KM INICIAL/FINAL por quincena y ruta, de la hoja OPERACION DE LAS RUTAS. SIN CHECK de km_final >= km_inicial a proposito: el dato real lo viola 10 veces (digitos mal tecleados que vienen en pares que se cancelan, ej. 205095 -> 23174 por 223174) y rechazarlo perderia la lectura. Se guarda tal cual y el veredicto lo pone km_status en la vista.'`);
  await knex.raw(`COMMENT ON VIEW analytics.v_route_operation_period IS 'RD.5 — la hoja OPERACION DE LAS RUTAS calculada bien. En el Excel COSTO FIJO X KM sale 1 para todas las rutas porque su SUMIF apunta a la columna PERIODO de su propia hoja en vez de a la ficha de costo, y de ahi cuelgan COSTO POR KM y % DE RENTABILIDAD. Aca el $/km se DERIVA de la ficha (costo_fijo_anual / km_base_anual = 6.12-9.13) y el rendimiento sale solo donde el odometro es coherente: 160 de 175 lecturas (91.4%), banda 0<km<=5000 medida como ~3x el p95. costo_status dice por que falta lo que falta.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_operation_period`);
  await knex.schema.withSchema('logistics').dropTableIfExists('route_odometer');
  await knex('logistics.config_finance').where('key', 'like', 'RD.%').andWhere({ category: 'costo_km' }).del();
};
