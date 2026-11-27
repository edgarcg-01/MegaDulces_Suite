'use strict';
/**
 * `[RD.C0.1][RD.C0.2]` — **El contraste deja de decir «no sé» sobre un día que la fuente trajo
 * cortado a la mitad.**
 *
 * ── Lo medido antes, contra prod en sólo lectura (2026-11-27) ───────────────────────────────
 *
 *  · El motor paga **$74,980.66 menos** que el libro sobre $937,781.87 (**−8.0 %**), y **65
 *    filas** de esa diferencia salen clasificadas `sin_explicar` por **−$30,721.89**.
 *  · Descompuesto pieza por pieza: **64 de 65 tienen la BASE distinta**. El motor no calcula
 *    distinto — **ve menos venta**. Y la base cuadra **al centavo** en 136 de 233 filas (Q1, Q3,
 *    Q8 y Q9 dan ratio 1.0000 exacto), o sea que la fórmula está bien.
 *  · **El 89 % de ese delta son 14 filas y una sola causa**: el **lunes 23-feb-2026** Wincaja
 *    cargó **7 de 17 sucursales**, y en la venta por ruta quedaron **2 rutas de 13** con
 *    **$2,263** contra los ~$240,000 de un lunes normal (Q4, −$23,431.91). Q7 agrega −$3,863.66.
 *
 * ── ⛔⛔ Por qué nadie lo vio en nueve meses ────────────────────────────────────────────────
 *
 * La vista clasificaba así:
 *
 *     WHEN mot.dias_con_venta < mot.dias_esperados THEN 'faltan_dias_en_la_fuente'
 *     ELSE 'sin_explicar'
 *
 * …y **`dias_esperados` se deriva de la MISMA fuente que `dias_con_venta`**. Si la ingesta trae
 * 11 días, el motor espera 11 y declara cobertura completa. **Un denominador sacado del numerador
 * no puede ver nunca un día que la fuente perdió.**
 *
 * ── ⛔⛔ Y por qué la primera versión de ESTA migración se tiró ─────────────────────────────
 *
 * Definí el día incompleto como *«menos del 60 % de las sucursales que Wincaja carga en la
 * mediana del año»*. Pasó su control puntual (23-feb: 7 contra 17) y devolvió **74 días**. No
 * eran huecos: **Wincaja se fue apagando** —17 sucursales hasta junio, 8 en julio, 2 en agosto,
 * **1 en septiembre**— porque las rutas migraron de fuente. Una mediana anual sobre una fuente
 * que cambió de forma **mide la migración, no el hueco**. El instrumento se tira, no la medición.
 *
 * ── ⭐⭐ El instrumento que queda, con sus controles ────────────────────────────────────────
 *
 * Compara cada día contra **su propia vecindad** (±9 días naturales, sin domingos) y cuenta
 * **rutas**, no sucursales. Y el discriminador que separa un hueco de un feriado es
 * **tickets por ruta**:
 *
 *     día truncado  ⇔  rutas < 60 % de la mediana local  Y  tickets/ruta < 5
 *
 *   | día        |     | rutas | tickets | mediana local | tickets/ruta | veredicto   |
 *   |------------|-----|------:|--------:|--------------:|-------------:|-------------|
 *   | 2026-02-23 | lun |     2 |       2 |            13 |      **1.0** | TRUNCADO    |
 *   | 2026-04-03 | vie |     6 |     141 |            13 |         23.5 | feriado     |
 *   | 2026-04-04 | sáb |     6 |     141 |            13 |         23.5 | feriado     |
 *   | 2026-09-16 | mié |     5 |     120 |            17 |         24.0 | feriado     |
 *
 * El 3 y 4 de abril y el 16 de septiembre operaron **pocas rutas, pero bien**. El 23 de febrero
 * las dos rutas que aparecen traen **un ticket cada una**: eso no es un camión que no salió, es
 * una carga cortada a la mitad. **Es el único día así en todo 2026.**
 *
 * ⛔ Por eso la causa se llama `carga_truncada` y **no** «la fuente perdió el día»: lo que se
 * puede medir es que el día vino truncado. Si el camión salió o no, el motor no lo sabe — y el
 * gate `cobertura_dias` ya lo dice con todas las letras.
 *
 * ── Por qué un SNAPSHOT y no sólo una vista ────────────────────────────────────────────────
 *
 * Medido hoy: derivar la cobertura de **una** quincena cuesta **35.5 s** en febrero y **1.1 s**
 * en noviembre. La diferencia es la frontera de `v_rd_route_daily_rapido`: lo reciente sale de
 * `mv_rd_route_daily_200d` (hoy, 11-may a 06-dic) y lo anterior de la vista **viva**. Contra el
 * listón de 500 ms, **colgarlo del contraste lo mataría** — hoy el contraste entero tarda 106 ms.
 *
 * Así que:
 *   · `analytics.v_rd_dia_cobertura`  → la **definición**, reutilizable, cara y documentada.
 *   · `analytics.rd_dia_cobertura`    → el **snapshot** de lo observado (≈280 filas al año).
 *   · el contraste lee el snapshot, nunca la vista.
 *
 * ⛔ El snapshot **no es una copia de una tabla** (regla 2): es una observación propia, cara de
 * derivar, que ninguna otra tabla tiene. Se llena **por evento** —cuando el motor calcula una
 * quincena— y con un backfill de una sola pasada. **Ningún cron.**
 *
 * ⚠️ Esta migración **no hace el backfill**: un barrido del año cuesta ~88 s y no va a sostener
 * el candado de migraciones (regla 9). Va en `scripts/rd-backfill-dia-cobertura.js`, y mientras
 * el snapshot esté vacío **la causa se comporta exactamente como antes** — compatible con la API
 * desplegada, que es lo que exige la regla de migraciones.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** La definición del día truncado, en un solo lugar. La usan la vista y el backfill. */
const SQL_COBERTURA = `
  WITH dia AS (
    SELECT s.tenant_id,
           s.business_date,
           count(DISTINCT s.route_code)::int AS rutas,
           coalesce(sum(s.tickets), 0)::int  AS tickets
      FROM analytics.v_rd_commission_sales s
     WHERE extract(dow FROM s.business_date) <> 0
     GROUP BY 1, 2
  )
  SELECT d.tenant_id,
         d.business_date,
         d.rutas,
         d.tickets,
         v.med_local,
         round(d.tickets::numeric / nullif(d.rutas, 0), 2) AS tickets_por_ruta,
         -- La carga se cortó: aparecen pocas rutas Y las que aparecen traen un puñado de tickets.
         (     v.med_local IS NOT NULL
           AND d.rutas < v.med_local * 0.6
           AND (d.tickets::numeric / nullif(d.rutas, 0)) < 5
         ) AS carga_truncada,
         -- Operaron pocas rutas, pero las que salieron trabajaron NORMAL: un feriado, no un hueco.
         (     v.med_local IS NOT NULL
           AND d.rutas < v.med_local * 0.6
           AND (d.tickets::numeric / nullif(d.rutas, 0)) >= 5
         ) AS operacion_parcial
    FROM dia d
    CROSS JOIN LATERAL (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n.rutas) AS med_local
        FROM dia n
       WHERE n.tenant_id = d.tenant_id
         AND n.business_date <> d.business_date
         AND n.business_date BETWEEN d.business_date - 9 AND d.business_date + 9
    ) v
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1 · La definición, reutilizable ────────────────────────────────────────────────────────
  // ⚠️ CARA para fechas anteriores a la matvista (~35 s por quincena). NO se consulta desde una
  //    pantalla: para eso está el snapshot de abajo.
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_rd_dia_cobertura AS ${SQL_COBERTURA}`);

  // ── 2 · El snapshot de lo observado ────────────────────────────────────────────────────────
  const existe = await knex.schema.withSchema('analytics').hasTable('rd_dia_cobertura');
  if (!existe) {
    await knex.schema.withSchema('analytics').createTable('rd_dia_cobertura', (t) => {
      t.uuid('tenant_id').notNullable();
      t.date('business_date').notNullable();
      t.integer('rutas').notNullable();
      t.integer('tickets').notNullable();
      t.decimal('med_local', 10, 2);
      t.decimal('tickets_por_ruta', 10, 2);
      t.boolean('carga_truncada').notNullable().defaultTo(false);
      t.boolean('operacion_parcial').notNullable().defaultTo(false);
      t.timestamp('observed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.uuid('updated_by');
      t.timestamp('deleted_at', { useTz: true });
      t.uuid('deleted_by');
      t.primary(['tenant_id', 'business_date']);
    });
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS rd_dia_cobertura_anomalo_idx
        ON analytics.rd_dia_cobertura (tenant_id, business_date)
        WHERE carga_truncada OR operacion_parcial`);
  } else {
    // La tabla ya existía de una aplicación anterior de ESTA migración: le falta la columna.
    const tieneParcial = await knex.schema
      .withSchema('analytics').hasColumn('rd_dia_cobertura', 'operacion_parcial');
    if (!tieneParcial) {
      await knex.schema.withSchema('analytics').alterTable('rd_dia_cobertura', (t) => {
        t.boolean('operacion_parcial').notNullable().defaultTo(false);
      });
    }
  }

  // ── 3 · El contraste, con la causa nueva ───────────────────────────────────────────────────
  // ⛔ Es la MISMA definición de siempre; lo único que cambia es el CASE de `causa` y el CTE
  //    `trunc` que lo alimenta. Todo lo demás se reproduce tal cual para no mover nada más.
  //
  // ⭐ `carga_truncada` va PRIMERO porque es la causa de la causa: cuando el día vino cortado,
  //    decir «le faltan días» describe el síntoma y manda a buscar al camión en vez de a la
  //    ingesta. Y cuando el snapshot todavía está vacío, el CASE cae a lo de antes.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_rd_commission_contrast AS
    WITH lib AS (
           SELECT r.period_id, l.*
             FROM commercial.commission_run_lines l
             JOIN commercial.commission_runs r
               ON r.id = l.run_id
              AND r.deleted_at IS NULL
              AND r.status::text <> 'anulado'::text
              AND r.origen::text = 'libro'::text
            WHERE l.deleted_at IS NULL
              AND l.beneficiario::text = 'chofer'::text
         ), mot AS (
           SELECT e.*
             FROM commercial.commission_engine_lines e
            WHERE e.beneficiario::text = 'chofer'::text
              AND (EXISTS ( SELECT 1
                              FROM commercial.commission_runs r
                             WHERE r.period_id = e.period_id
                               AND r.deleted_at IS NULL
                               AND r.status::text <> 'anulado'::text
                               AND r.origen::text = 'libro'::text))
         ), claves AS (
           SELECT lib_1.tenant_id, lib_1.period_id, lib_1.route_code FROM lib lib_1
           UNION
           SELECT mot_1.tenant_id, mot_1.period_id, mot_1.route_code FROM mot mot_1
         ), trunc AS (
           -- Los días ANÓMALOS que caen dentro de cada periodo. Lee el SNAPSHOT (tabla), nunca
           -- la vista: el contraste tiene que seguir contestando en milisegundos.
           SELECT p.tenant_id,
                  p.id AS period_id,
                  count(*) FILTER (WHERE c.carga_truncada)::int    AS dias_truncados,
                  count(*) FILTER (WHERE c.operacion_parcial)::int AS dias_operacion_parcial,
                  string_agg(to_char(c.business_date, 'DD-Mon'), ', '
                             ORDER BY c.business_date)
                    FILTER (WHERE c.carga_truncada)                AS dias_truncados_txt,
                  string_agg(to_char(c.business_date, 'DD-Mon'), ', '
                             ORDER BY c.business_date)
                    FILTER (WHERE c.operacion_parcial)             AS dias_operacion_parcial_txt
             FROM commercial.commission_periods p
             JOIN analytics.rd_dia_cobertura c
               ON c.tenant_id = p.tenant_id
              AND c.deleted_at IS NULL
              AND (c.carga_truncada OR c.operacion_parcial)
              AND c.business_date BETWEEN p.date_from AND p.date_to
            WHERE p.deleted_at IS NULL
            GROUP BY 1, 2
         )
    SELECT k.tenant_id,
           p.id AS period_id,
           p.anio,
           p.period_no,
           to_char(p.date_from::timestamp with time zone, 'YYYY-MM-DD'::text) AS date_from,
           to_char(p.date_to::timestamp with time zone,   'YYYY-MM-DD'::text) AS date_to,
           k.route_code,
           lib.beneficiario_nombre,
           lib.zona,
           lib.venta         AS libro_venta,
           lib.subtotal      AS libro_subtotal,
           lib.pct_aplicado  AS libro_pct,
           lib.comision      AS libro_comision,
           lib.bonos         AS libro_bonos,
           lib.nomina_banco  AS libro_nomina,
           lib.a_pagar       AS libro_a_pagar,
           lib.motivo_no_pago AS libro_motivo,
           mot.venta         AS motor_venta,
           mot.subtotal      AS motor_subtotal,
           mot.pct_aplicado  AS motor_pct,
           mot.comision      AS motor_comision,
           mot.bonos         AS motor_bonos,
           mot.a_pagar       AS motor_a_pagar,
           mot.motivo_no_pago AS motor_motivo,
           mot.dias_con_venta,
           mot.dias_esperados,
           mot.costo_veredicto,
           mot.computed_at,
           CASE
               WHEN lib.a_pagar IS NULL OR mot.a_pagar IS NULL THEN NULL::numeric
               ELSE round(mot.a_pagar - lib.a_pagar, 2)
           END AS delta_a_pagar,
           CASE
               WHEN mot.route_code IS NULL THEN 'sin_corrida_del_motor'::text
               WHEN lib.route_code IS NULL THEN 'solo_el_motor'::text
               WHEN lib.motivo_no_pago IS NOT NULL AND mot.motivo_no_pago IS NOT NULL THEN 'ninguno_paga'::text
               WHEN lib.motivo_no_pago IS NOT NULL THEN 'solo_el_motor_paga'::text
               WHEN mot.motivo_no_pago IS NOT NULL THEN 'el_motor_no_paga'::text
               WHEN abs(mot.a_pagar - lib.a_pagar) <= 1.00 THEN 'cuadra'::text
               WHEN abs(mot.a_pagar - lib.a_pagar) <= (abs(NULLIF(lib.a_pagar, 0::numeric)) * 0.05) THEN 'difiere_poco'::text
               ELSE 'difiere'::text
           END AS veredicto,
           CASE
               WHEN mot.route_code IS NULL THEN NULL::text
               -- ⭐ El ORDEN importa y se corrigió el 2026-11-27 con la prueba en la mano: puesto
               --    al revés, dia_de_operacion_parcial le robaba la causa a 4 filas que ya tenían
               --    una MEJOR (faltan_dias_en_la_fuente). Lo que le pasa a UNA ruta es más
               --    específico que lo que le pasa al día, así que gana.
               --    La excepción es carga_truncada: cuando el día vino cortado, «le faltan días a
               --    esta ruta» es la CONSECUENCIA, no la causa, y mandaría a buscar al camión en
               --    vez de a la ingesta.
               -- ⛔ Sin acentos graves acá dentro: esto vive en un template literal de JS.
               WHEN coalesce(t.dias_truncados, 0) > 0 THEN 'carga_truncada'::text
               WHEN mot.dias_con_venta IS NULL OR mot.dias_esperados IS NULL THEN 'cobertura_no_medida'::text
               WHEN mot.dias_con_venta < mot.dias_esperados THEN 'faltan_dias_en_la_fuente'::text
               WHEN coalesce(t.dias_operacion_parcial, 0) > 0 THEN 'dia_de_operacion_parcial'::text
               ELSE 'sin_explicar'::text
           END AS causa,
           t.dias_truncados,
           t.dias_truncados_txt,
           t.dias_operacion_parcial,
           t.dias_operacion_parcial_txt
      FROM claves k
      JOIN commercial.commission_periods p
        ON p.id = k.period_id AND p.tenant_id = k.tenant_id AND p.deleted_at IS NULL
      LEFT JOIN lib ON lib.tenant_id = k.tenant_id AND lib.period_id = k.period_id AND lib.route_code::text = k.route_code::text
      LEFT JOIN mot ON mot.tenant_id = k.tenant_id AND mot.period_id = k.period_id AND mot.route_code::text = k.route_code::text
      LEFT JOIN trunc t ON t.tenant_id = k.tenant_id AND t.period_id = k.period_id
     WHERE NOT (lib.route_code IS NULL AND mot.motivo_no_pago IS NOT NULL)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // El contraste vuelve a su CASE anterior (sin `carga_truncada` ni las dos columnas nuevas).
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_rd_commission_contrast AS
    WITH lib AS (
           SELECT r.period_id, l.*
             FROM commercial.commission_run_lines l
             JOIN commercial.commission_runs r
               ON r.id = l.run_id AND r.deleted_at IS NULL
              AND r.status::text <> 'anulado'::text AND r.origen::text = 'libro'::text
            WHERE l.deleted_at IS NULL AND l.beneficiario::text = 'chofer'::text
         ), mot AS (
           SELECT e.* FROM commercial.commission_engine_lines e
            WHERE e.beneficiario::text = 'chofer'::text
              AND (EXISTS ( SELECT 1 FROM commercial.commission_runs r
                             WHERE r.period_id = e.period_id AND r.deleted_at IS NULL
                               AND r.status::text <> 'anulado'::text AND r.origen::text = 'libro'::text))
         ), claves AS (
           SELECT lib_1.tenant_id, lib_1.period_id, lib_1.route_code FROM lib lib_1
           UNION
           SELECT mot_1.tenant_id, mot_1.period_id, mot_1.route_code FROM mot mot_1
         )
    SELECT k.tenant_id, p.id AS period_id, p.anio, p.period_no,
           to_char(p.date_from::timestamp with time zone, 'YYYY-MM-DD'::text) AS date_from,
           to_char(p.date_to::timestamp with time zone,   'YYYY-MM-DD'::text) AS date_to,
           k.route_code, lib.beneficiario_nombre, lib.zona,
           lib.venta AS libro_venta, lib.subtotal AS libro_subtotal, lib.pct_aplicado AS libro_pct,
           lib.comision AS libro_comision, lib.bonos AS libro_bonos, lib.nomina_banco AS libro_nomina,
           lib.a_pagar AS libro_a_pagar, lib.motivo_no_pago AS libro_motivo,
           mot.venta AS motor_venta, mot.subtotal AS motor_subtotal, mot.pct_aplicado AS motor_pct,
           mot.comision AS motor_comision, mot.bonos AS motor_bonos, mot.a_pagar AS motor_a_pagar,
           mot.motivo_no_pago AS motor_motivo, mot.dias_con_venta, mot.dias_esperados,
           mot.costo_veredicto, mot.computed_at,
           CASE WHEN lib.a_pagar IS NULL OR mot.a_pagar IS NULL THEN NULL::numeric
                ELSE round(mot.a_pagar - lib.a_pagar, 2) END AS delta_a_pagar,
           CASE
               WHEN mot.route_code IS NULL THEN 'sin_corrida_del_motor'::text
               WHEN lib.route_code IS NULL THEN 'solo_el_motor'::text
               WHEN lib.motivo_no_pago IS NOT NULL AND mot.motivo_no_pago IS NOT NULL THEN 'ninguno_paga'::text
               WHEN lib.motivo_no_pago IS NOT NULL THEN 'solo_el_motor_paga'::text
               WHEN mot.motivo_no_pago IS NOT NULL THEN 'el_motor_no_paga'::text
               WHEN abs(mot.a_pagar - lib.a_pagar) <= 1.00 THEN 'cuadra'::text
               WHEN abs(mot.a_pagar - lib.a_pagar) <= (abs(NULLIF(lib.a_pagar, 0::numeric)) * 0.05) THEN 'difiere_poco'::text
               ELSE 'difiere'::text
           END AS veredicto,
           CASE
               WHEN mot.route_code IS NULL THEN NULL::text
               WHEN mot.dias_con_venta IS NULL OR mot.dias_esperados IS NULL THEN 'cobertura_no_medida'::text
               WHEN mot.dias_con_venta < mot.dias_esperados THEN 'faltan_dias_en_la_fuente'::text
               ELSE 'sin_explicar'::text
           END AS causa
      FROM claves k
      JOIN commercial.commission_periods p
        ON p.id = k.period_id AND p.tenant_id = k.tenant_id AND p.deleted_at IS NULL
      LEFT JOIN lib ON lib.tenant_id = k.tenant_id AND lib.period_id = k.period_id AND lib.route_code::text = k.route_code::text
      LEFT JOIN mot ON mot.tenant_id = k.tenant_id AND mot.period_id = k.period_id AND mot.route_code::text = k.route_code::text
     WHERE NOT (lib.route_code IS NULL AND mot.motivo_no_pago IS NOT NULL)`);

  await knex.raw(`DROP VIEW IF EXISTS analytics.v_rd_dia_cobertura`);
  await knex.schema.withSchema('analytics').dropTableIfExists('rd_dia_cobertura');
};
