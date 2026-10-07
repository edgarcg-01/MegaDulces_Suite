/**
 * Horus — auditoría de calidad de datos (read-only).
 *
 * Mide, sobre daily_captures REAL, qué señales tienen cobertura suficiente para
 * que el motor de findings (Horus.1) genere hallazgos defendibles vs cuáles
 * serían humo. NO escribe nada. Decide qué reglas activar y cómo calibrar umbrales.
 *
 * Uso: node database/scripts/horus-data-audit.js
 */
require('dotenv').config();

const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5433,
    database: process.env.DB_NAME || 'postgres_platform',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  pool: {
    min: 1,
    max: 2,
    afterCreate: (conn, done) => {
      // Emula el search_path de KNEX_CONNECTION (resuelve daily_captures/stores
      // sin calificar a las tablas reales en sus schemas).
      conn.query(
        'SET search_path TO trade, field_ops, identity, catalog, scoring, commercial, public',
        (err) => done(err, conn),
      );
    },
  },
});

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

async function main() {
  const out = (label, val) => console.log(`  ${label.padEnd(42)} ${val}`);

  // 0) ¿Dónde vive daily_captures? (confirma schema)
  const loc = await knex.raw(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'daily_captures' ORDER BY 1`,
  );
  console.log('\n=== Ubicación de daily_captures ===');
  console.log('  schemas:', loc.rows.map((r) => r.table_schema).join(', ') || '(no encontrada)');

  // 1) Volumen + cobertura de columnas clave
  const c = (
    await knex.raw(`
    SELECT
      count(*) FILTER (WHERE hora_inicio >= now() - interval '30 days')                                   AS caps_30d,
      count(*) FILTER (WHERE hora_inicio >= now() - interval '60 days')                                   AS caps_60d,
      count(*) FILTER (WHERE hora_inicio >= now() - interval '30 days' AND score_final_pct IS NOT NULL)    AS score_30d,
      count(*) FILTER (WHERE hora_inicio >= now() - interval '30 days' AND store_id IS NOT NULL)           AS store_30d,
      count(DISTINCT user_id)  FILTER (WHERE hora_inicio >= now() - interval '30 days')                    AS collaborators_30d,
      count(DISTINCT store_id) FILTER (WHERE hora_inicio >= now() - interval '30 days' AND store_id IS NOT NULL) AS stores_30d,
      count(DISTINCT tenant_id)                                                                            AS tenants_total
    FROM daily_captures
  `)
  ).rows[0];

  console.log('\n=== Volumen y cobertura de columnas (daily_captures) ===');
  out('Capturas 30d / 60d', `${c.caps_30d} / ${c.caps_60d}`);
  out('Con score_final_pct (30d)', `${c.score_30d} (${pct(c.score_30d, c.caps_30d)})`);
  out('Con store_id (30d)', `${c.store_30d} (${pct(c.store_30d, c.caps_30d)})`);
  out('Colaboradores activos (30d)', c.collaborators_30d);
  out('Tiendas distintas con store_id (30d)', c.stores_30d);
  out('Tenants con capturas', c.tenants_total);

  // 2) Distribución de perteneceMegaDulces + foto (a nivel exhibición, 30d)
  const e = (
    await knex.raw(`
    SELECT
      count(*)                                                                       AS exhibiciones,
      count(*) FILTER (WHERE (ex->>'perteneceMegaDulces') = 'true')                  AS own,
      count(*) FILTER (WHERE (ex->>'perteneceMegaDulces') = 'false')                 AS competitor,
      count(*) FILTER (WHERE ex->>'perteneceMegaDulces' IS NULL)                     AS unknown,
      count(*) FILTER (WHERE ex->>'fotoUrl' IS NOT NULL AND ex->>'fotoUrl' <> '')    AS with_photo
    FROM daily_captures dc, jsonb_array_elements(dc.exhibiciones) ex
    WHERE dc.hora_inicio >= now() - interval '30 days'
  `)
  ).rows[0];

  console.log('\n=== Exhibiciones (30d) — clasificación propio/competencia + foto ===');
  out('Exhibiciones totales', e.exhibiciones);
  out('perteneceMegaDulces=true (propio)', `${e.own} (${pct(e.own, e.exhibiciones)})`);
  out('perteneceMegaDulces=false (competencia)', `${e.competitor} (${pct(e.competitor, e.exhibiciones)})`);
  out('perteneceMegaDulces=null (sin clasificar)', `${e.unknown} (${pct(e.unknown, e.exhibiciones)})`);
  out('Con fotoUrl', `${e.with_photo} (${pct(e.with_photo, e.exhibiciones)})`);

  // 3) Distribución de score (para calibrar el umbral de low_score)
  const s = (
    await knex.raw(`
    SELECT
      round(min(score_final_pct), 1)                                                  AS min,
      round(avg(score_final_pct), 1)                                                  AS avg,
      round((percentile_cont(0.25) WITHIN GROUP (ORDER BY score_final_pct))::numeric, 1) AS p25,
      round((percentile_cont(0.5)  WITHIN GROUP (ORDER BY score_final_pct))::numeric, 1) AS p50,
      round(max(score_final_pct), 1)                                                  AS max
    FROM daily_captures
    WHERE hora_inicio >= now() - interval '30 days' AND score_final_pct IS NOT NULL
  `)
  ).rows[0];

  console.log('\n=== score_final_pct (30d) — para calibrar low_score ===');
  out('min / p25 / mediana / avg / max', `${s.min} / ${s.p25} / ${s.p50} / ${s.avg} / ${s.max}`);

  // 4) Visitas por colaborador (30d) — para fijar min_observations sin perder cobertura
  const v = (
    await knex.raw(`
    SELECT
      count(*)                                AS collaborators,
      count(*) FILTER (WHERE visitas >= 3)    AS with_3plus,
      count(*) FILTER (WHERE visitas >= 5)    AS with_5plus,
      round(avg(visitas), 1)                  AS avg_visitas
    FROM (
      SELECT user_id, count(*) AS visitas
      FROM daily_captures
      WHERE hora_inicio >= now() - interval '30 days'
      GROUP BY user_id
    ) t
  `)
  ).rows[0];

  console.log('\n=== Visitas por colaborador (30d) — umbral min_observations ===');
  out('Colaboradores', v.collaborators);
  out('Con >= 3 visitas', v.with_3plus);
  out('Con >= 5 visitas', v.with_5plus);
  out('Promedio visitas/colaborador', v.avg_visitas);

  console.log('\n(read-only; no se escribió nada)\n');
  await knex.destroy();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  knex.destroy().finally(() => process.exit(1));
});
