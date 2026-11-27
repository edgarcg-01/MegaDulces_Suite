'use strict';
/**
 * `[RD.C0.2b]` — **Un día que todavía está ocurriendo no se juzga.**
 *
 * ── El defecto, cazado por el modo seco antes de escribir una sola fila (2026-11-27) ────────
 *
 * La primera corrida de `scripts/rd-backfill-dia-cobertura.js`, en seco, devolvió **dos** días
 * con carga truncada:
 *
 *     Mon Feb 23   2 rutas ·  2 tickets · 1.00 por ruta (mediana local 13)
 *     Fri Nov 27   2 rutas ·  5 tickets · 2.50 por ruta (mediana local 19)   ← ERA ESE MISMO DÍA
 *
 * El 27 de noviembre era **hoy**, a media mañana: tenía dos rutas porque el día apenas había
 * empezado. De haberse escrito, la quincena **en curso** (Q24, 19-nov a 02-dic) habría quedado
 * marcada `carga_truncada` y el contraste habría publicado una causa falsa sobre un periodo que
 * ni siquiera cerró.
 *
 * ⭐ Es el caso de libro de por qué el backfill nace **en seco por defecto**: el instrumento
 * acertó su control (23-feb) y aun así traía un falso positivo que sólo se ve mirando la lista.
 *
 * ── La corrección ──────────────────────────────────────────────────────────────────────────
 *
 * Un día sólo se juzga cuando **ya cerró y la serie siguió sin él**:
 *
 *   1. `business_date < current_date` — el día en curso nunca se evalúa.
 *   2. **Al menos 3 días hábiles posteriores con dato.** Esto cubre lo que la primera regla no
 *      ve: si la ingesta de ayer todavía no llegó, ayer *parece* truncado. Exigir que la serie
 *      haya seguido adelante distingue «vino cortado» de «todavía no vino».
 *
 * ⚠️ El costo, declarado: **los últimos 3 días hábiles nunca se marcan acá**. Es a propósito —
 * esta vista alimenta el contraste HISTÓRICO, donde un falso positivo publica una causa falsa
 * sobre dinero. Avisar el mismo día que una carga vino cortada es otro problema, con otro
 * instrumento (`[RD.C0.4]`, la compuerta de ingesta), que compara contra los días **previos** y
 * no necesita esperar a los siguientes.
 *
 * Idempotente: sólo reemplaza la vista.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * ⚠️ `dias_habiles_despues` se cuenta sobre la MISMA serie observada, no sobre el calendario:
 * lo que importa es que la fuente haya seguido entregando después de ese día.
 */
const SQL_COBERTURA = `
  WITH dia AS (
    SELECT s.tenant_id,
           s.business_date,
           count(DISTINCT s.route_code)::int AS rutas,
           coalesce(sum(s.tickets), 0)::int  AS tickets
      FROM analytics.v_rd_commission_sales s
     WHERE extract(dow FROM s.business_date) <> 0
     GROUP BY 1, 2
  ), con_vecindad AS (
    SELECT d.tenant_id,
           d.business_date,
           d.rutas,
           d.tickets,
           v.med_local,
           p.dias_habiles_despues
      FROM dia d
      CROSS JOIN LATERAL (
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n.rutas) AS med_local
          FROM dia n
         WHERE n.tenant_id = d.tenant_id
           AND n.business_date <> d.business_date
           AND n.business_date BETWEEN d.business_date - 9 AND d.business_date + 9
      ) v
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS dias_habiles_despues
          FROM dia f
         WHERE f.tenant_id = d.tenant_id
           AND f.business_date > d.business_date
           AND f.business_date <= d.business_date + 9
      ) p
  )
  -- ⛔ El ORDEN de las columnas no es cosmético: \`CREATE OR REPLACE VIEW\` sólo deja AGREGAR al
  --    final, nunca insertar en medio ni renombrar. Medido el 2026-11-27: poner las dos nuevas
  --    antes de \`carga_truncada\` hizo fallar la migración con «cannot change name of view column
  --    "carga_truncada" to "dias_habiles_despues"». Las nuevas van AL FINAL, siempre.
  SELECT c.tenant_id,
         c.business_date,
         c.rutas,
         c.tickets,
         c.med_local,
         round(c.tickets::numeric / nullif(c.rutas, 0), 2) AS tickets_por_ruta,
         (     c.business_date < current_date
           AND c.dias_habiles_despues >= 3
           AND c.med_local IS NOT NULL
           AND c.rutas < c.med_local * 0.6
           AND (c.tickets::numeric / nullif(c.rutas, 0)) < 5
         ) AS carga_truncada,
         (     c.business_date < current_date
           AND c.dias_habiles_despues >= 3
           AND c.med_local IS NOT NULL
           AND c.rutas < c.med_local * 0.6
           AND (c.tickets::numeric / nullif(c.rutas, 0)) >= 5
         ) AS operacion_parcial,
         -- Las dos columnas NUEVAS, al final por lo dicho arriba.
         c.dias_habiles_despues,
         -- Sólo se juzga un día CERRADO y con la serie ya seguida: ver el encabezado.
         (c.business_date < current_date AND c.dias_habiles_despues >= 3) AS evaluable
    FROM con_vecindad c
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_rd_dia_cobertura AS ${SQL_COBERTURA}`);

  // El snapshot gana la misma columna, para que una fila guardada diga si fue evaluable o no.
  const tiene = await knex.schema
    .withSchema('analytics').hasColumn('rd_dia_cobertura', 'dias_habiles_despues');
  if (!tiene) {
    await knex.schema.withSchema('analytics').alterTable('rd_dia_cobertura', (t) => {
      t.integer('dias_habiles_despues');
      t.boolean('evaluable').notNullable().defaultTo(false);
    });
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // La vista vuelve a la versión de [RD.C0.2], que juzgaba también el día en curso.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_rd_dia_cobertura AS
    WITH dia AS (
      SELECT s.tenant_id, s.business_date,
             count(DISTINCT s.route_code)::int AS rutas,
             coalesce(sum(s.tickets), 0)::int  AS tickets
        FROM analytics.v_rd_commission_sales s
       WHERE extract(dow FROM s.business_date) <> 0
       GROUP BY 1, 2
    )
    SELECT d.tenant_id, d.business_date, d.rutas, d.tickets, v.med_local,
           round(d.tickets::numeric / nullif(d.rutas, 0), 2) AS tickets_por_ruta,
           (v.med_local IS NOT NULL AND d.rutas < v.med_local * 0.6
            AND (d.tickets::numeric / nullif(d.rutas, 0)) < 5) AS carga_truncada,
           (v.med_local IS NOT NULL AND d.rutas < v.med_local * 0.6
            AND (d.tickets::numeric / nullif(d.rutas, 0)) >= 5) AS operacion_parcial,
           NULL::int AS dias_habiles_despues,
           true AS evaluable
      FROM dia d
      CROSS JOIN LATERAL (
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n.rutas) AS med_local
          FROM dia n
         WHERE n.tenant_id = d.tenant_id
           AND n.business_date <> d.business_date
           AND n.business_date BETWEEN d.business_date - 9 AND d.business_date + 9
      ) v`);

  const tiene = await knex.schema
    .withSchema('analytics').hasColumn('rd_dia_cobertura', 'dias_habiles_despues');
  if (tiene) {
    await knex.schema.withSchema('analytics').alterTable('rd_dia_cobertura', (t) => {
      t.dropColumn('dias_habiles_despues');
      t.dropColumn('evaluable');
    });
  }
};
